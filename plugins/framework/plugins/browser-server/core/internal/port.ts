// A browser server across a message port: a server booted in a Web Worker
// (`serveOverPort`, the worker side) is a `BrowserServer` in the page
// (`portBrowserServer`, the page side), so `browserServerTransport` and every
// app call path run unchanged against a server in another realm. The two ends
// speak the closed message vocabulary below — requests and responses as plain
// data (bodies as transferred `ArrayBuffer`s, so a bytes resource crosses
// intact), notifications sockets as numbered connections carrying the
// resource-protocol frames verbatim.

import type {
  BrowserServer,
  BrowserServerPeer,
  BrowserServerSocket,
} from "./browser-server";

/** Either end of a port: a `Worker` in the page, the worker's own `self` inside it. */
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

/** Page → worker. */
type ToHost =
  | { t: "request"; id: number; request: WireRequest }
  | { t: "open"; conn: number }
  | { t: "frame"; conn: number; frame: string }
  | { t: "close"; conn: number; code: number; reason: string };

/** Worker → page. */
type FromHost =
  | { t: "ready"; keys: string[] }
  | { t: "failed"; error: string }
  | { t: "response"; id: number; response: WireResponse }
  | { t: "deliver"; conn: number; frame: string }
  | { t: "closed"; conn: number; code: number; reason: string };

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

/**
 * Serve a server on `port` (the worker's `self`): post `ready` with its keys —
 * or `failed`, when `boot` throws — then answer every request and socket
 * message the page sends. Boot failures are loud on both sides: the error is
 * rethrown here too, so the worker's console shows the stack.
 */
export async function serveOverPort(
  port: PortEnd,
  boot: () => Promise<PortServer>,
): Promise<void> {
  // Listen first: a message the page sends while the graph boots waits for it.
  const booted = boot();
  const sockets = new Map<number, BrowserServerSocket>();
  const post = (msg: FromHost, transfer?: Transferable[]) =>
    port.postMessage(msg, transfer);

  port.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as ToHost;
    void handle(msg).catch((err: unknown) => {
      console.error("[browser-server] worker host failed a message:", err);
      throw err;
    });
  });

  async function handle(msg: ToHost): Promise<void> {
    const { server } = await booted;
    switch (msg.t) {
      case "request": {
        const { method, url, headers, body } = msg.request;
        const res = await server.request(
          new Request(url, { method, headers, body }),
        );
        const response = await toWireResponse(res);
        post({ t: "response", id: msg.id, response }, [response.body]);
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

  let host: PortServer;
  try {
    host = await booted;
  } catch (err) {
    const error =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    post({ t: "failed", error });
    throw err;
  }
  post({ t: "ready", keys: [...host.keys] });
}

/** A server across a port that never booted: `boot` threw in the worker. */
export class PortHostBootError extends Error {
  constructor(readonly hostError: string) {
    super(`the browser server's worker failed to boot:\n${hostError}`);
    this.name = "PortHostBootError";
  }
}

/** A booted server across a port, with the keys it serves. */
export interface PortServer {
  server: BrowserServer;
  keys: ReadonlySet<string>;
}

/**
 * The page side: a `BrowserServer` over `port` (a `Worker` running
 * `serveOverPort`), resolved once the worker reports `ready`; rejected with
 * `PortHostBootError` when it reports `failed`. `dispose` closes every socket
 * from the server's side; ending the worker is the caller's.
 */
export function portBrowserServer(port: PortEnd): Promise<PortServer> {
  let nextId = 0;
  const pending = new Map<number, (res: Response) => void>();
  const peers = new Map<number, BrowserServerPeer>();

  const server: BrowserServer = {
    id: globalThis.crypto.randomUUID(),
    async request(req) {
      const id = nextId++;
      const request = await toWireRequest(req);
      const answer = new Promise<Response>((resolve) =>
        pending.set(id, resolve),
      );
      port.postMessage(
        { t: "request", id, request } satisfies ToHost,
        request.body === null ? [] : [request.body],
      );
      return answer;
    },
    connect(peer) {
      const conn = nextId++;
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
          resolve({ server, keys: new Set(msg.keys) });
          return;
        case "failed":
          reject(new PortHostBootError(msg.error));
          return;
        case "response": {
          const { status, statusText, headers, body } = msg.response;
          const settle = pending.get(msg.id);
          pending.delete(msg.id);
          settle?.(
            new Response(status === 204 || status === 304 ? null : body, {
              status,
              statusText,
              headers,
            }),
          );
          return;
        }
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
