import type { BrowserServer } from "../core";
import {
  publishWsStatus,
  type Transport,
  type TransportSocket,
} from "@plugins/primitives/plugins/networking/web";

// The `Transport` over a browser server: what a `<TransportProvider>` points a
// subtree at so the unchanged app (live-state's `NotificationsProvider`, the
// endpoints hooks) talks to it instead of the page's origin. Make ONE per
// server and keep it: the scoped live-state pipeline is keyed by the
// transport's identity.

/** The worktree notifications socket — the one channel a browser server hosts. */
const NOTIFICATIONS_PATH = "/ws/notifications";

/** The origin a relative request is resolved against: never fetched, only parsed. */
const REQUEST_BASE = "http://browser-server.invalid";

/** A socket over `server.connect`, shaped like the `SharedWebSocket` a client expects. */
function connectedSocket(server: BrowserServer, url: string): TransportSocket {
  let will: string | null = null;
  let closed = false;
  let connection: string | null = null;
  const socket: TransportSocket = {
    onopen: null,
    onmessage: null,
    // One tab per socket: nothing shares it.
    attachedTabs: 1,
    get connection() {
      return connection;
    },
    send(data) {
      if (closed) return;
      end.send(data);
    },
    setLastWill(data) {
      will = data;
    },
    close() {
      if (closed) return;
      closed = true;
      if (will !== null) end.send(will);
      end.close();
      connection = null;
      publishWsStatus({ url, status: "closed" });
    },
  };
  // Frames are delivered on a microtask, so a reply never re-enters the
  // client's `send` that caused it.
  const end = server.connect({
    deliver(frame) {
      queueMicrotask(() => {
        if (closed) return;
        socket.onmessage?.(new MessageEvent("message", { data: frame }));
      });
    },
    // The server went away (disposed): nothing more is sent, the will
    // included — there is no server left to release anything on.
    closed() {
      if (closed) return;
      closed = true;
      connection = null;
      publishWsStatus({ url, status: "closed" });
    },
  });
  queueMicrotask(() => {
    if (closed) return;
    connection = `${server.id}:${url}`;
    publishWsStatus({ url, status: "open" });
    socket.onopen?.(new Event("open"));
  });
  return socket;
}

/**
 * A socket on a channel the server does not host (central): it never opens,
 * and says so on the status bus — a central read falls back to HTTP, which the
 * server answers as unsupported.
 */
function inertSocket(url: string): TransportSocket {
  queueMicrotask(() => publishWsStatus({ url, status: "closed" }));
  return {
    onopen: null,
    onmessage: null,
    attachedTabs: 1,
    connection: null,
    send() {},
    setLastWill() {},
    close() {},
  };
}

/**
 * The transport of a browser server: its sockets and its requests (an asset
 * included — no URL reaches it, so elements get blob URLs). `telemetry` says
 * whether the telemetry its traffic raises is reported (to the page's own
 * server — a browser server has nowhere of its own to keep it): the enclosing
 * page's setting (`useTransport().telemetry` where the scope is mounted), or
 * `false` to drop it.
 */
export function browserServerTransport(
  server: BrowserServer,
  { telemetry }: { telemetry: boolean },
): Transport {
  const prefix = `browser:${server.id}:`;
  return {
    socketUrl: (path) => `${prefix}${path}`,
    openSocket(url) {
      if (url === `${prefix}${NOTIFICATIONS_PATH}`) {
        return connectedSocket(server, url);
      }
      return inertSocket(url);
    },
    fetch(input, init) {
      // A Request already carries an absolute URL; only its path is routed.
      if (input instanceof Request) {
        return server.request(
          init === undefined ? input : new Request(input, init),
        );
      }
      return server.request(
        new Request(new URL(String(input), REQUEST_BASE), init),
      );
    },
    // No URL reaches a server in the page: an element's asset is fetched
    // through `fetch` above and handed over as a blob URL (`useAssetSrc`).
    servesUrls: false,
    // A server in the page: the computer is not behind it.
    machine: false,
    telemetry,
  };
}
