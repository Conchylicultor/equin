import type {
  RuntimeSocket,
  WsHandler,
} from "@plugins/framework/plugins/resource-runtime/core";
import type {
  BrowserServer,
  BrowserServerPeer,
  BrowserServerSocket,
} from "./browser-server";

/** A runtime's notifications handler, as any host hands it out. */
export type NotificationsHandler = Pick<
  WsHandler,
  "open" | "message" | "close"
>;

/**
 * The open sockets of one server, each with how the server closes it from its
 * own side — what `dispose` walks.
 */
export type OpenSockets = Map<
  BrowserServerSocket,
  (code: number, reason: string) => void
>;

/**
 * Open one in-memory notifications socket on a runtime's handler: the
 * `connect` of a server that hosts a resource runtime in this realm (a
 * worker's booted graph, `runtimeBrowserServer`). `open` tracks it until it
 * closes, so the server can close it from its side.
 */
export function connectRuntimeSocket(
  ws: NotificationsHandler,
  peer: BrowserServerPeer,
  open: OpenSockets,
): BrowserServerSocket {
  let closed = false;
  // One stable object per connection: the runtime keys its socket state by it.
  const socket: RuntimeSocket = {
    send: (frame) => {
      if (!closed) peer.deliver(frame);
    },
  };
  const end: BrowserServerSocket = {
    send(frame) {
      if (closed) {
        throw new Error("browser-server: send on a closed socket");
      }
      ws.message(socket, frame);
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      open.delete(end);
      ws.close(socket, code, reason);
    },
  };
  ws.open(socket);
  open.set(end, (code, reason) => {
    end.close(code, reason);
    peer.closed(code, reason);
  });
  return end;
}

/**
 * A `BrowserServer` over a resource runtime some host booted in this realm —
 * its request router and its notifications handler (a worker's booted plugin
 * graph, `server-core`'s `bootBrowserHost`). `dispose` closes its sockets; the
 * runtime itself lives as long as the realm.
 */
export function runtimeBrowserServer(host: {
  request(req: Request): Promise<Response>;
  notifications: NotificationsHandler;
}): BrowserServer {
  const open: OpenSockets = new Map();
  return {
    id: globalThis.crypto.randomUUID(),
    request: (req) => host.request(req),
    connect: (peer) => connectRuntimeSocket(host.notifications, peer, open),
    dispose() {
      for (const closeFromServer of [...open.values()]) {
        closeFromServer(1001, "browser server disposed");
      }
    },
  };
}
