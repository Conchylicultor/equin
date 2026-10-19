import {
  createRequestHandler,
  type RouteHandler,
} from "@plugins/framework/plugins/http-router/core";
import {
  createResourceRuntime,
  type KeyedResourceContract,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  bindExternalServe,
  type LiveExternalServe,
} from "@plugins/network/plugins/live/core";
import { unsupportedEndpointResponse } from "@plugins/infra/plugins/endpoints/core";
import { RESOURCE_HTTP_ROUTE } from "@plugins/packages/plugins/resource-protocol/core";
import {
  allResourceDescriptors,
  onResourceDescriptorRegistered,
  type ResourceDescriptor,
} from "@plugins/primitives/plugins/live-state/core";
import { connectRuntimeSocket, type OpenSockets } from "./runtime-socket";

// A server that runs in the page: the third host of the unified live API,
// beside the Bun server and central. It contributes only what a host does —
// its runtime instance, its socket and request entry points, its error sink and
// what it serves; declarations, the client, the wire protocol, serving
// (`serveValueOn` / `serveCollectionOn`) and routing (`http-router`) are the
// one code path every host runs. See
// `research/2026-10-13-framework-browser-server-host-v2.md` (D).

/** What `serve` is handed: the external arm of `serveValue` / `serveCollection`, on this server's runtime. */
export type BrowserServe = LiveExternalServe<"worktree">;

/** What `serve` returns per served declaration: the keys it registered (every served value and collection carries them). */
export interface BrowserServed {
  keys: readonly string[];
}

export interface BrowserServerOptions {
  /**
   * Serve declarations on this server's runtime, through `s.serveValue` /
   * `s.serveCollection` (external arm only — a browser server has no change
   * feed). Returns what it served; every other known key is `unserved`.
   */
  serve: (s: BrowserServe) => readonly BrowserServed[];
  /** `["METHOD /path/:param", handler]` pairs, e.g. `[ep.route, implement(ep, h)]`. */
  routes?: Iterable<[key: string, handler: RouteHandler]>;
  /**
   * The error a read of a key nothing served fails with. Every resource
   * descriptor this page knows (now, and as lazy plugins register more) that
   * `serve` did not serve is registered with a loader throwing this — so its
   * reader sees a `loader-failed` read, never an unknown key (which the client
   * would take for version skew and advise a reload).
   */
  unserved: (key: string) => Error;
  /** A route handler's throw, before the generic 500. Default: `console.error`. */
  onError?: (err: Error, req: Request, pathname: string) => void;
  /**
   * The response to a request no route matches. Default: an `/api/…` path is
   * `unsupportedEndpointResponse` (`infra/endpoints`: the server is real, the
   * endpoint is simply not part of this one); any other path a 404 naming it.
   */
  onUnmatched?: (req: Request, pathname: string) => Response;
}

/** The client side of an in-memory socket: where the server's frames go. */
export interface BrowserServerPeer {
  deliver(frame: string): void;
  /**
   * The SERVER closed the socket (`dispose`) — the twin of a real socket's
   * close event: the client must stop sending (its end now throws).
   */
  closed(code: number, reason: string): void;
}

/** The server side of an in-memory socket, as `connect` hands it to the client. */
export interface BrowserServerSocket {
  /** A client frame (`sub`, `sub-batch`, `unsub`, …) into the runtime. Throws once closed. */
  send(frame: string): void;
  /** Release the socket's subscriptions and stop its heartbeat. Idempotent. */
  close(code?: number, reason?: string): void;
}

export interface BrowserServer {
  /** Unique per server — what a transport names its sockets and assets by. */
  readonly id: string;
  /** One HTTP request through the shared router (`/api/resources/:key` included). */
  request(req: Request): Promise<Response>;
  /** Open an in-memory notifications socket on the runtime. */
  connect(peer: BrowserServerPeer): BrowserServerSocket;
  /** Close every socket and stop following late descriptors. */
  dispose(): void;
}

function defaultOnError(err: Error, req: Request, pathname: string): void {
  console.error(`[browser-server] ${req.method} ${pathname} threw:`, err);
}

function defaultOnUnmatched(req: Request, pathname: string): Response {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return unsupportedEndpointResponse(req.method, pathname);
  }
  return new Response(`Not found: ${pathname}`, { status: 404 });
}

/**
 * Create a browser server.
 *
 * ```ts
 * const server = createBrowserServer({
 *   serve: (s) => [
 *     s.serveValue(transcript, { source: "external", changes: { fixed: { reason: "demo pack" } },
 *       loader: ({ id }) => pack.transcript(id) }),
 *   ],
 *   routes: [[markViewed.route, implement(markViewed, () => undefined)]],
 *   unserved: (key) => new Error(`not served here: ${key}`),
 * });
 * <TransportProvider transport={browserServerTransport(server)}>…</TransportProvider>
 * ```
 */
export function createBrowserServer(opts: BrowserServerOptions): BrowserServer {
  // Every option off: no read-set, no L2, no profiler; the portable snapHash.
  const rt = createResourceRuntime({});

  const served = new Set<string>();
  for (const s of opts.serve(bindExternalServe(rt, "worktree"))) {
    for (const key of s.keys) served.add(key);
  }

  const registerUnserved = (d: ResourceDescriptor<unknown>): void => {
    // A central value is read over the central channel, which this server
    // does not host (its socket is inert, its HTTP reads unmatched).
    if (served.has(d.key) || d.origin === "central") return;
    const key = d.key;
    const loader = () => Promise.reject(opts.unserved(key));
    if (d.keyed !== undefined) {
      // The point arm registers any keyed contract (window or `:rows`) and
      // reads nothing before its loader, which fails.
      const contract: KeyedResourceContract<unknown> = { ...d, keyed: d.keyed };
      rt.defineExternalResource(contract, {
        loader,
        membership: { kind: "point", idsOf: () => [] },
      });
    } else {
      rt.defineExternalResource(
        { ...d, keyed: undefined },
        {
          mode: d.load === "on-demand" ? "invalidate" : "push",
          loader,
        },
      );
    }
  };
  for (const d of allResourceDescriptors()) registerUnserved(d);
  // A lazy plugin's descriptors register after boot; the runtime takes a late
  // definition on open sockets.
  const stopFollowing = onResourceDescriptorRegistered(registerUnserved);

  const request = createRequestHandler({
    routes: [
      ...(opts.routes ?? []),
      [RESOURCE_HTTP_ROUTE, rt.handleResourceHttp],
    ],
    onError: opts.onError ?? defaultOnError,
    onUnmatched: opts.onUnmatched ?? defaultOnUnmatched,
  });

  /** Every open socket, with how the server closes it from its side. */
  const open: OpenSockets = new Map();

  return {
    id: globalThis.crypto.randomUUID(),
    request,
    connect: (peer) =>
      connectRuntimeSocket(rt.notificationsWsHandler, peer, open),
    dispose() {
      stopFollowing();
      for (const closeFromServer of [...open.values()]) {
        closeFromServer(1001, "browser server disposed");
      }
    },
  };
}
