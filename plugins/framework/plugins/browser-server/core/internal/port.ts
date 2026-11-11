// A browser server across a message port: a server booted in a worker
// (`serveHost` / `serveOverPort`, the worker side) is a `BrowserServer` in the
// page (`portBrowserServer`, the page side), so `browserServerTransport` and
// every app call path run unchanged against a server in another realm. The two
// ends speak the closed message vocabulary below — requests and responses as
// plain data (bodies as transferred `ArrayBuffer`s, so a bytes resource crosses
// intact), notifications sockets as numbered connections carrying the
// resource-protocol frames verbatim. A page can also hand the worker a second
// port (`attach`) that it answers requests on the same way — how a frame-serving
// Service Worker (`web/frames-sw.ts`) reaches the server without the page.
//
// A worker serves one END per page: a dedicated worker's own `self`, or each
// connection of a SharedWorker — several tabs sharing one server. Each end is
// told `ready` (or why the host could not boot) on its own; a host that stops
// serving (another worker took its storage over, or the page reset it) tells
// every end `ended`, after which the page rejects whatever it still waits on.
//
// A SharedWorker host outlives its last tab (`extendedLifetime`), so what the
// tab asked for is finished and flushed, then RETIRES itself (`retire`): see
// `shared-host.ts` for the lock that keeps a connecting page off a worker that
// is closing.

import { watchHostProgress, type HostProgress } from "./boot-progress";
import {
  declarePageInputs,
  receivePageInput,
  type PageInputValue,
} from "./page-inputs";
import type {
  BrowserServer,
  BrowserServerPeer,
  BrowserServerSocket,
} from "./browser-server";

/** Either end of a port: a `Worker` or a `MessagePort` in the page, the worker's own `self` (or a SharedWorker connection) inside it. */
export interface PortEnd {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
}

interface WireRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

interface WireResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

/**
 * Why a host stopped serving. Each arm is a different cause with its own way
 * out, so a page decides by it (an exhaustive switch), never by a catch-all.
 */
export type HostEndReason =
  /** A page reset the host: its data is wiped, a fresh host boots on reconnect. */
  | "reset"
  /** No page held the host any more: it closed its storage and the worker. */
  | "retired"
  /** Another version of the host's code (a newer build, loaded in another tab) took its storage over. */
  | "updated"
  /**
   * The same host in another tab's own worker took its storage over: the
   * browser has no SharedWorker, so its tabs cannot share one host.
   */
  | "unshared";

/**
 * Why a host declined to boot for a page — on purpose, not a crash. Each arm
 * is decided by its cause, like `HostEndReason`.
 */
export type HostRefusal =
  /** The host's data (or the host holding it) is from newer code than this worker's. */
  | { kind: "outdated" }
  /**
   * The same host already serves the storage, as the SharedWorker named
   * `worker`: the page connects to it instead (a tab joins the running host,
   * never takes it).
   */
  | { kind: "join"; worker: string };

/** Page → worker. */
export type ToHost =
  | { t: "request"; id: number; request: WireRequest }
  | { t: "open"; conn: number }
  | { t: "frame"; conn: number; frame: string }
  | { t: "close"; conn: number; code: number; reason: string }
  /**
   * Serve `port` too, exactly as the worker's own port: another realm (a
   * frame-serving Service Worker) sends its requests there.
   */
  | { t: "attach"; port: MessagePort }
  /**
   * The page holds the Web Lock `lock` for as long as it uses this end; the
   * host drops the end's sockets once it is released (the tab closed or
   * crashed — a MessagePort says nothing when its other side goes away).
   */
  | { t: "hello"; lock: string }
  /** The page inputs this page supplies (`PortServerOptions.inputs`). */
  | { t: "inputs"; keys: string[] }
  /** One page input's value (`PortServer.supply`). */
  | { t: "input"; key: string; input: PageInputValue }
  /** Wipe the host's data and end it (Reset). */
  | { t: "reset" };

/** Worker → page. */
export type FromHost =
  /**
   * The first message on every connection: the host has taken this end in,
   * and will not retire while it stays (`connectSharedHost` holds the retire
   * lock until it hears this).
   */
  | { t: "accepted" }
  | {
      t: "ready";
      keys: string[];
      boot: HostBoot;
      readyAtMs: number;
    }
  | { t: "failed"; error: string }
  /** How far the boot has come (`HostProgress`), posted to every page waiting for it until it settles. */
  | { t: "progress"; progress: HostProgress }
  /** The host declined to boot (`HostRefusedError`), for `refusal`. */
  | { t: "refused"; refusal: HostRefusal }
  | { t: "ended"; why: HostEndReason }
  | { t: "response"; id: number; response: WireResponse }
  | { t: "deliver"; conn: number; frame: string }
  | { t: "closed"; conn: number; code: number; reason: string };

/**
 * A boot the host declines on purpose (`HostRefusal`: its data is newer than
 * its code, or the same host already serves it elsewhere) — not a crash.
 * Thrown by a host's `boot`; the page receives it as `PortHostRefusedError`
 * and acts on `refusal` rather than reaching an error boundary.
 */
export class HostRefusedError extends Error {
  constructor(
    readonly refusal: HostRefusal,
    detail: string,
  ) {
    super(`the host declined to boot (${refusal.kind}): ${detail}`);
    this.name = "HostRefusedError";
  }
}

async function toWireRequest(req: Request): Promise<WireRequest> {
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? null
      : await req.arrayBuffer();
  return {
    method: req.method,
    url: req.url,
    headers: [...req.headers.entries()],
    body,
  };
}

async function toWireResponse(res: Response): Promise<WireResponse> {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    body: await res.arrayBuffer(),
  };
}

export interface ServeHostOptions {
  /**
   * How the pages' ends arrive: call `serve` with each — a dedicated worker's
   * `self` once, or every connection a SharedWorker accepts.
   */
  accept: (serve: (end: PortEnd) => void) => void;
  boot: () => Promise<HostBooted>;
  /**
   * Wipe the host's data, for a page's `reset`. Absent: this host has nothing
   * to reset, and a `reset` throws.
   */
  reset?: () => Promise<void>;
  /**
   * After every end was told `ended`. A host with `retire` closes there (its
   * worker closes only under the retire lock, a Reset's end included); one
   * without closes its worker here.
   */
  onEnded?: (why: HostEndReason) => void;
  /**
   * A SharedWorker host's end of life: once its last end has left (its page's
   * `hello` lock released) and every request it was handling has settled, the
   * host takes `lock` (`retireLockName` of the worker's name) exclusively —
   * granted only while no page is connecting to it (`connectSharedHost`) — and,
   * still with no end, ends `retired` and runs `run` (close the storage, then
   * the worker), holding the lock until the worker is gone. A connection that
   * arrives first takes the ask back. Absent: the host never retires (a
   * dedicated worker, which ends with its page).
   */
  retire?: { lock: string; run: () => Promise<void> };
}

/** A host being served: end it from the worker's side. */
export interface ServedHost {
  /** Tell every page end `why` and answer nothing more, then `onEnded`. */
  end(why: HostEndReason): void;
}

/**
 * Serve a host's server on every page end `accept` hands over: post `ready`
 * with its keys and how its boot went — or `refused` (a `HostRefusedError`) /
 * `failed`, when `boot` throws — then answer every request and socket message
 * the page sends. Boot failures are loud on both sides: the worker's console
 * shows the stack.
 */
export function serveHost(opts: ServeHostOptions): ServedHost {
  // Listen first: a message a page sends while the graph boots waits for it.
  const booted = opts.boot();
  // Every page end is told (`failed` / `refused`); the worker's console gets
  // the stack. Not rethrown: `serveOverPort`'s caller awaits the boot itself.
  void booted.catch((err: unknown) => {
    if (err instanceof HostRefusedError) return;
    console.error("[browser-server] the host failed to boot:", err);
  });
  /** The boot settled: an end served from now on did not wait for it. */
  let bootSettled = false;
  // Either way: a failed boot is reported above, and to each end below.
  const settle = (): void => {
    bootSettled = true;
  };
  void booted.then(settle, settle);

  /** Every page end being served, and the sockets each opened. */
  const ends = new Map<PortEnd, Map<number, BrowserServerSocket>>();
  // How far the boot has come, to every page waiting for it — and, as it
  // connects, to a page that arrives mid-boot.
  let progress: HostProgress | null = null;
  const stopProgress = watchHostProgress((next) => {
    progress = next;
    if (bootSettled) return;
    for (const end of ends.keys())
      end.postMessage({ t: "progress", progress: next } satisfies FromHost);
  });
  void booted.then(stopProgress, stopProgress);
  /** Ends attached by a page (a frame-serving Service Worker's): told `ended` too. */
  const attached = new Set<PortEnd>();
  let ended: HostEndReason | null = null;
  /** Set as a reset starts: from then on, nothing reaches the server it is wiping. */
  let stopping = false;

  const dropSockets = (sockets: Map<number, BrowserServerSocket>): void => {
    for (const socket of sockets.values()) socket.close(1001, "page gone");
    sockets.clear();
  };

  /** Answer every message `end` sends; its sockets are its own. */
  function serveEnd(end: PortEnd, announce: boolean): void {
    const sockets = new Map<number, BrowserServerSocket>();
    if (announce) {
      ends.set(end, sockets);
      // Before `accepted`: the page stops holding the retire lock once it
      // hears it, so no retirement asked for earlier may still be waiting.
      retiring?.abort();
      retiring = null;
    }
    const post = (msg: FromHost, transfer?: Transferable[]) =>
      end.postMessage(msg, transfer);
    if (announce) post({ t: "accepted" });
    end.addEventListener("message", (event: MessageEvent) => {
      const msg = event.data as ToHost;
      void handle(msg, end, sockets, post).catch((err: unknown) => {
        console.error("[browser-server] worker host failed a message:", err);
        throw err;
      });
    });
    if (announce && !bootSettled && progress !== null)
      post({ t: "progress", progress });
    if (announce) void announceTo(post);
  }

  async function announceTo(post: (msg: FromHost) => void): Promise<void> {
    let host: HostBooted;
    try {
      host = await booted;
    } catch (err) {
      if (err instanceof HostRefusedError) {
        post({ t: "refused", refusal: err.refusal });
      } else {
        const error =
          err instanceof Error ? (err.stack ?? err.message) : String(err);
        post({ t: "failed", error });
      }
      return;
    }
    if (ended !== null) {
      post({ t: "ended", why: ended });
      return;
    }
    // A dedicated worker's clock starts when the page creates it, so this is
    // the whole wait: the bundle's fetch and evaluation, then the boot.
    post({
      t: "ready",
      keys: [...host.keys],
      boot: host.boot,
      readyAtMs: Math.round(performance.now()),
    });
  }

  async function handle(
    msg: ToHost,
    end: PortEnd,
    sockets: Map<number, BrowserServerSocket>,
    post: (msg: FromHost, transfer?: Transferable[]) => void,
  ): Promise<void> {
    if (msg.t === "attach") {
      serveEnd(msg.port, false);
      attached.add(msg.port);
      // `addEventListener` alone does not start a MessagePort.
      msg.port.start();
      return;
    }
    if (msg.t === "hello") {
      // The page releases the lock when it ends (or its tab goes away).
      void navigator.locks.request(
        msg.lock,
        { mode: "exclusive" },
        async () => {
          dropSockets(sockets);
          ends.delete(end);
          maybeRetire();
        },
      );
      return;
    }
    if (msg.t === "inputs") {
      declarePageInputs(msg.keys);
      return;
    }
    if (msg.t === "input") {
      receivePageInput(msg.key, msg.input);
      return;
    }
    if (ended !== null || stopping) return;
    if (msg.t === "reset") {
      if (opts.reset === undefined) {
        throw new Error(
          "[browser-server] reset: this host has nothing to reset",
        );
      }
      stopping = true;
      try {
        // Only a page the host told `ready` offers Reset: the boot succeeded.
        await booted;
        await opts.reset();
      } finally {
        // Ended even when the wipe failed part-way: this host cannot serve a
        // half-wiped storage, and the next one heals it (a storage whose
        // reset did not finish opens as a dead first boot and is wiped again).
        endAll("reset");
      }
      return;
    }
    const { server } = await booted;
    if (ended !== null || stopping) return;
    switch (msg.t) {
      case "request": {
        const { method, url, headers, body } = msg.request;
        // Counted until answered: a retirement waits for it, so a request
        // whose page has already gone still finishes and is flushed.
        const answering = (async () => {
          const res = await server.request(
            new Request(url, { method, headers, body }),
          );
          if (ended !== null) return;
          const response = await toWireResponse(res);
          post({ t: "response", id: msg.id, response }, [response.body]);
        })();
        inFlight.add(answering);
        try {
          await answering;
        } finally {
          inFlight.delete(answering);
          maybeRetire();
        }
        return;
      }
      case "open": {
        const conn = msg.conn;
        const peer: BrowserServerPeer = {
          deliver: (frame) => post({ t: "deliver", conn, frame }),
          closed: (code, reason) => post({ t: "closed", conn, code, reason }),
        };
        sockets.set(conn, server.connect(peer));
        return;
      }
      case "frame":
        sockets.get(msg.conn)?.send(msg.frame);
        return;
      case "close":
        sockets.get(msg.conn)?.close(msg.code, msg.reason);
        sockets.delete(msg.conn);
        return;
    }
  }

  /** Requests being answered (`request` messages), for a retirement to wait on. */
  const inFlight = new Set<Promise<void>>();
  /** The retire lock asked for, while it is: aborted by a new end. */
  let retiring: AbortController | null = null;

  /** The retirement began (its lock granted, nothing holding the host): never asked for again. */
  let retired = false;

  /**
   * Retire when nothing holds the host: no end, no request being answered,
   * booted (a failed boot closed its storage itself; the worker retires all
   * the same) — or once it ended, whatever ended it (a Reset's wipe done, or
   * another worker took its storage over: its pages are told, and the worker
   * still has to go). Always under the retire lock, so a page connecting by
   * this name meanwhile — a stale tab — moves on to the next one instead of
   * reaching a closing worker. Asks for the retire lock; whatever arrives
   * while it waits takes the ask back or is checked again once it is granted.
   */
  function maybeRetire(): void {
    const retire = opts.retire;
    if (retire === undefined || retiring !== null || retired) return;
    // Mid-Reset: the wipe is running; it ends the host, which retires then.
    if (stopping && ended === null) return;
    const held = (): boolean =>
      ended === null && (ends.size > 0 || inFlight.size > 0 || !bootSettled);
    if (held()) return;
    const ask = new AbortController();
    retiring = ask;
    void navigator.locks
      .request(retire.lock, { signal: ask.signal }, async () => {
        if (retiring === ask) retiring = null;
        if (held() || (stopping && ended === null) || retired) return;
        retired = true;
        if (ended === null) endAll("retired");
        await retire.run().catch((err: unknown) => {
          // Loud — the worker's uncaught error — and the lock still held.
          reportError(err);
        });
        // Held until the worker is gone, even when closing failed: a page
        // that finds it held connects to another worker, never to this
        // closing one.
        await new Promise<never>(() => {});
      })
      .catch((err: unknown) => {
        if (ask.signal.aborted) return;
        console.error("[browser-server] the host failed to retire:", err);
        throw err;
      });
  }
  void booted.then(maybeRetire, maybeRetire);

  function endAll(why: HostEndReason): void {
    if (ended !== null) return;
    ended = why;
    for (const [end, sockets] of ends) {
      // Told first, so the page reads the close as the host ending.
      end.postMessage({ t: "ended", why } satisfies FromHost);
      dropSockets(sockets);
    }
    ends.clear();
    for (const end of attached) {
      end.postMessage({ t: "ended", why } satisfies FromHost);
    }
    attached.clear();
    opts.onEnded?.(why);
    // Ended, so nothing it serves holds it any more: it goes (`retire`).
    maybeRetire();
  }

  opts.accept((end) => serveEnd(end, true));
  return { end: endAll };
}

/**
 * Serve a server on ONE end (a dedicated worker's `self`): `serveHost` with
 * that end alone and nothing to reset. Resolves once the boot did; rejects
 * with its error (the page is told too).
 */
export async function serveOverPort(
  port: PortEnd,
  boot: () => Promise<HostBooted>,
): Promise<void> {
  const booted = boot();
  serveHost({ accept: (serve) => serve(port), boot: () => booted });
  await booted;
}

/** A server across a port that never booted: `boot` threw in the worker. */
export class PortHostBootError extends Error {
  constructor(readonly hostError: string) {
    super(`the browser server's worker failed to boot:\n${hostError}`);
    this.name = "PortHostBootError";
  }
}

/** The host declined to boot (`HostRefusedError` in the worker), for `refusal`. */
export class PortHostRefusedError extends Error {
  constructor(readonly refusal: HostRefusal) {
    super(`the browser server declined to boot (${refusal.kind})`);
    this.name = "PortHostRefusedError";
  }
}

/** A request the host will never answer: it ended (`why`) first. */
export class HostEndedError extends Error {
  constructor(readonly why: HostEndReason) {
    super(`the browser server ended (${why}) before answering`);
    this.name = "HostEndedError";
  }
}

/**
 * How a host's boot spent its time, on its own clock — the shape
 * `server-core`'s `bootBrowserHost` reports (`BrowserHostBoot`), restated here
 * because server-core sits above this plugin; a host passes its report
 * through, so tsc checks the two agree.
 */
export interface HostBoot {
  /** Graph nodes booted. */
  plugins: number;
  /** The boot's stages, in order. */
  stages: readonly { name: string; ms: number }[];
  /** Its slowest spans. */
  slowest: readonly { label: string; ms: number }[];
  /**
   * Where the data it booted on came from (a storage-backed host says: what
   * an earlier boot stored, a snapshot, nothing). Absent: the host keeps none.
   */
  data?: string;
  /**
   * When the worker was created, on the wall clock (its
   * `performance.timeOrigin`, ms since the epoch): a page places it on its
   * own clock, to tell the wait for the worker to exist from its boot.
   */
  createdAt?: number;
}

/** A server booted in the worker: what `serveHost`'s `boot` returns. */
export interface HostBooted {
  server: BrowserServer;
  keys: ReadonlySet<string>;
  boot: HostBoot;
}

/** A booted server across a port, with the keys it serves and how its boot went. */
export interface PortServer extends HostBooted {
  /** When the worker reported ready: ms after it was created, on its clock. */
  readyAtMs: number;
  /** Resolves when the host stops serving (`ended`); never, while it serves. */
  ended: Promise<HostEndReason>;
  /** Ask the host to wipe its data and end (it answers with `ended: "reset"`). */
  reset(): void;
  /** Hand the host the value of one page input this page declared (`inputs`). */
  supply(key: string, input: PageInputValue): void;
  /** Declare more page inputs this page supplies (a supply loaded after connect). */
  declareInputs(keys: readonly string[]): void;
}

/** What a page tells the host as it connects. */
export interface PortServerOptions {
  /**
   * The page inputs this page will supply (`pageInput`): read as `absent` by
   * the host only when no connected page declares them.
   */
  inputs?: readonly string[];
  /** Told how far the host's boot has come, until it is ready (`HostProgress`). */
  onProgress?: (progress: HostProgress) => void;
}

/**
 * Requests over `port` (an end a server answers on: a worker running
 * `serveHost`, or a port `attachPort` handed it): each one out as plain
 * data, its response back. Listens on `port` for the responses itself; the
 * caller starts a `MessagePort` (`addEventListener` alone does not). Once the
 * host says `ended`, every request still waiting — and every later one —
 * rejects with `HostEndedError`.
 */
export function portRequester(
  port: PortEnd,
): (req: Request) => Promise<Response> {
  let nextId = 0;
  let ended: HostEndReason | null = null;
  const pending = new Map<
    number,
    { resolve: (res: Response) => void; reject: (err: Error) => void }
  >();
  port.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as FromHost;
    if (msg.t === "ended") {
      ended = msg.why;
      for (const { reject } of pending.values())
        reject(new HostEndedError(msg.why));
      pending.clear();
      return;
    }
    if (msg.t !== "response") return;
    const { status, statusText, headers, body } = msg.response;
    const settle = pending.get(msg.id);
    pending.delete(msg.id);
    settle?.resolve(
      new Response(status === 204 || status === 304 ? null : body, {
        status,
        statusText,
        headers,
      }),
    );
  });
  return async (req) => {
    if (ended !== null) throw new HostEndedError(ended);
    const id = nextId++;
    const request = await toWireRequest(req);
    const answer = new Promise<Response>((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    port.postMessage(
      { t: "request", id, request } satisfies ToHost,
      request.body === null ? [] : [request.body],
    );
    return answer;
  };
}

/**
 * Hand the server behind `worker` (running `serveHost`) one more end to
 * answer on — `port` is transferred; whoever holds its twin (a frame-serving
 * Service Worker) reaches the server through `portRequester(twin)`.
 */
export function attachPort(worker: PortEnd, port: MessagePort): void {
  worker.postMessage({ t: "attach", port } satisfies ToHost, [port]);
}

/**
 * The page side: a `BrowserServer` over `port` (a worker, or a SharedWorker's
 * port, running `serveHost`), resolved once the host reports `ready`; rejected
 * with `PortHostRefusedError` when it declines to boot, `PortHostBootError`
 * when its boot failed. `dispose` closes every socket from the server's side
 * and lets the host forget this page; ending the worker is the caller's.
 *
 * A SharedWorker's connection is made by `connectSharedHost`, which also
 * tells the host when this page goes away (`hello`).
 */
export function portBrowserServer(
  port: PortEnd,
  { inputs = [], onProgress }: PortServerOptions = {},
): Promise<PortServer> {
  let nextConn = 0;
  const peers = new Map<number, BrowserServerPeer>();

  // Before any request: a read of an input is answered knowing who supplies it.
  port.postMessage({ t: "inputs", keys: [...inputs] } satisfies ToHost);

  let endedWith!: (why: HostEndReason) => void;
  const ended = new Promise<HostEndReason>((resolve) => (endedWith = resolve));

  const server: BrowserServer = {
    id: globalThis.crypto.randomUUID(),
    request: portRequester(port),
    connect(peer) {
      const conn = nextConn++;
      peers.set(conn, peer);
      port.postMessage({ t: "open", conn } satisfies ToHost);
      let closed = false;
      return {
        send(frame) {
          if (closed) {
            throw new Error("browser-server: send on a closed socket");
          }
          port.postMessage({ t: "frame", conn, frame } satisfies ToHost);
        },
        close(code = 1000, reason = "") {
          if (closed) return;
          closed = true;
          peers.delete(conn);
          port.postMessage({ t: "close", conn, code, reason } satisfies ToHost);
        },
      };
    },
    dispose() {
      for (const [conn, peer] of [...peers]) {
        peers.delete(conn);
        port.postMessage({
          t: "close",
          conn,
          code: 1001,
          reason: "browser server disposed",
        } satisfies ToHost);
        peer.closed(1001, "browser server disposed");
      }
    },
  };

  return new Promise<PortServer>((resolve, reject) => {
    port.addEventListener("message", (event: MessageEvent) => {
      const msg = event.data as FromHost;
      switch (msg.t) {
        case "ready":
          resolve({
            server,
            keys: new Set(msg.keys),
            boot: msg.boot,
            readyAtMs: msg.readyAtMs,
            ended,
            reset: () => port.postMessage({ t: "reset" } satisfies ToHost),
            supply: (key, input) =>
              port.postMessage({ t: "input", key, input } satisfies ToHost),
            declareInputs: (keys) =>
              port.postMessage({
                t: "inputs",
                keys: [...keys],
              } satisfies ToHost),
          });
          return;
        case "failed":
          reject(new PortHostBootError(msg.error));
          return;
        case "refused":
          reject(new PortHostRefusedError(msg.refusal));
          return;
        case "progress":
          onProgress?.(msg.progress);
          return;
        case "ended":
          // Every socket is gone with the host; the requests are
          // `portRequester`'s.
          for (const [conn, peer] of [...peers]) {
            peers.delete(conn);
            peer.closed(1012, `browser server ended: ${msg.why}`);
          }
          endedWith(msg.why);
          return;
        case "response":
          // `portRequester`'s.
          return;
        case "accepted":
          // `connectSharedHost`'s, where it connected.
          return;
        case "deliver":
          peers.get(msg.conn)?.deliver(msg.frame);
          return;
        case "closed": {
          const peer = peers.get(msg.conn);
          peers.delete(msg.conn);
          peer?.closed(msg.code, msg.reason);
          return;
        }
      }
    });
  });
}
