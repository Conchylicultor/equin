/**
 * The shaped link the website's load harnesses run over (enter-cost,
 * home-load): a CONNECT proxy shaping every tunnel through two shared lanes
 * (a token bucket per direction plus half the RTT each way), each connection
 * holding at most a receive window of unread bytes — never DevTools
 * throttling, which hangs these loads. See enter-cost.ts's header for why the
 * window matters (the hero film).
 */
import { createServer, connect, type Socket } from "node:net";
import { namespaceFromHost } from "@plugins/infra/plugins/namespace/core";

export interface Shape {
  /** Downlink, kbit/s. */
  downKbps: number;
  /** Uplink, kbit/s. */
  upKbps: number;
  /** Round trip added to every connection, ms. */
  rttMs: number;
}

export interface Shaper {
  port: number;
  /** TLS bytes delivered to the browser so far. */
  downBytes(): number;
  /**
   * The downlink's bytes the browser received between two wall-clock
   * instants, per what they answered: a plain-http tunnel's current request
   * path, a TLS tunnel's host (its requests are encrypted).
   */
  deliveredBetween(from: number, to: number): Map<string, number>;
  /** How long, from now, the downlink stays busy with what it holds, ms. */
  backlogMs(): number;
  close(): Promise<void>;
}

/** One direction of the shaped link: chunks leave it serialized at its rate, then travel half the RTT. */
class Lane {
  private nextFree = 0;
  bytes = 0;
  constructor(
    private readonly bytesPerMs: number,
    private readonly oneWayMs: number,
  ) {}
  backlogMs(): number {
    return Math.max(0, this.nextFree - performance.now());
  }
  /** When `len` bytes handed over now arrive, as a delay from now. */
  schedule(len: number): number {
    const now = performance.now();
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + len / this.bytesPerMs;
    this.bytes += len;
    return this.nextFree + this.oneWayMs - now;
  }
}

/** A CONNECT proxy shaping every tunnel through two shared lanes. */
export async function startShaper(
  shape: Shape,
  /** A tunnel's receive window on the shaped link, bytes (0: none). */
  receiveWindow: number,
): Promise<Shaper> {
  const down = new Lane((shape.downKbps * 1000) / 8 / 1000, shape.rttMs / 2);
  const up = new Lane((shape.upKbps * 1000) / 8 / 1000, shape.rttMs / 2);
  const sockets = new Set<Socket>();
  const delivered: Array<{ at: number; bytes: number; label: string }> = [];
  // One FIFO per direction of a tunnel: a chunk is written when its arrival
  // time comes, never before the chunk ahead of it (timers round to whole
  // ms, so one timer per chunk could swap two — and corrupt the TLS stream).
  //
  // A tunnel holds at most receiveWindow bytes on the link that its receiver has not
  // taken yet — TCP's receive window: when the browser stops reading a
  // response (a <video preload="metadata"> once it has its metadata), its
  // server stops sending, so the bytes it never reads never cross the link.
  // Without it the proxy would pull every response from the local server at
  // once and charge the link for all of it (`--window 0`: that model).
  const pipe = (
    from: Socket,
    to: Socket,
    lane: Lane,
    label: (() => string) | null,
  ) => {
    const queue: Array<{ at: number; chunk: Buffer | null }> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unread = 0;
    const taken = (len: number) => {
      unread -= len;
      if (from.isPaused() && unread <= receiveWindow / 2) from.resume();
    };
    const drain = () => {
      timer = null;
      const now = performance.now();
      while (queue.length > 0 && queue[0]!.at <= now + 0.5) {
        const { chunk } = queue.shift()!;
        if (to.destroyed) return;
        if (chunk === null) to.end();
        else {
          if (label !== null)
            delivered.push({
              at: Date.now(),
              bytes: chunk.length,
              label: label(),
            });
          to.write(chunk, () => taken(chunk.length));
        }
      }
      if (queue.length > 0)
        timer = setTimeout(drain, Math.max(0, queue[0]!.at - now));
    };
    const enqueue = (at: number, chunk: Buffer | null) => {
      queue.push({ at, chunk });
      if (timer === null)
        timer = setTimeout(
          drain,
          Math.max(0, queue[0]!.at - performance.now()),
        );
    };
    from.on("data", (chunk: Buffer) => {
      unread += chunk.length;
      if (receiveWindow > 0 && unread > receiveWindow) from.pause();
      enqueue(performance.now() + lane.schedule(chunk.length), chunk);
    });
    from.on("end", () => {
      const last = queue.at(-1)?.at ?? performance.now();
      enqueue(last, null);
    });
    from.on("error", () => to.destroy());
  };
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.once("data", (head: Buffer) => {
      const line = head.toString("latin1").split("\r\n")[0] ?? "";
      const m = /^CONNECT ([^:\s]+):(\d+) /.exec(line);
      if (m === null) {
        // A plain-http target (a local build at `http://<ns>.localhost`):
        // the request, in absolute form, goes to its origin as is (the
        // gateway reads the Host header), and the connection stays piped to
        // that origin — a local build's page and worker fetch from one host.
        const h = /^[A-Z]+ http:\/\/([^/:\s]+)(?::(\d+))?\//.exec(line);
        if (h === null) {
          client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
          return;
        }
        // A namespace's host names the local gateway.
        const host = namespaceFromHost(h[1]!) === null ? h[1]! : "127.0.0.1";
        // Hold what else the client sends until the pipe listens.
        client.pause();
        // The request a response answers: HTTP/1.1 answers in order, and
        // the browser sends the next request on a connection only once the
        // previous response is in, so the latest request line names it.
        let current = new URL(line.split(" ")[1]!).pathname;
        client.on("data", (chunk: Buffer) => {
          const req = /^[A-Z]+ (http:\/\/\S+) HTTP/.exec(
            chunk.toString("latin1", 0, 2048),
          );
          if (req !== null) current = new URL(req[1]!).pathname;
        });
        const upstream = connect(Number(h[2] ?? 80), host, () => {
          setTimeout(() => {
            pipe(upstream, client, down, () => current);
            pipe(client, upstream, up, null);
            client.emit("data", head);
            client.resume();
          }, shape.rttMs);
        });
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        return;
      }
      const upstream = connect(Number(m[2]), m[1]!, () => {
        // The tunnel opens after one round trip, as a real connection would.
        setTimeout(() => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipe(upstream, client, down, () => m[1]!);
          pipe(client, upstream, up, null);
        }, shape.rttMs);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
    client.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("shaper: no TCP address");
  return {
    port: address.port,
    downBytes: () => down.bytes,
    backlogMs: () => down.backlogMs(),
    deliveredBetween: (from, to) => {
      const out = new Map<string, number>();
      for (const d of delivered)
        if (d.at >= from && d.at < to)
          out.set(d.label, (out.get(d.label) ?? 0) + d.bytes);
      return out;
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The profiles the load-model research measured with (fast 4G is its §2 profile, slow 4G Lighthouse's). */
export const PROFILES: Record<string, Shape | null> = {
  desktop: null,
  fast4g: { downKbps: 9000, upKbps: 1500, rttMs: 60 },
  slow4g: { downKbps: 1600, upKbps: 750, rttMs: 150 },
};
