import { createRequestHandler } from "@plugins/framework/plugins/http-router/core";
import {
  createResourceRuntime,
  type ResourceRuntime,
} from "@plugins/framework/plugins/resource-runtime/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { RESOURCE_HTTP_ROUTE } from "@plugins/packages/plugins/resource-protocol/core";
import type { BrowserServer } from "../internal/browser-server";
import { serveOverPort } from "../internal/port";
import { runtimeBrowserServer } from "../internal/runtime-socket";

export interface InRealmServerOptions {
  /**
   * Serve declarations on the server's runtime — `serveValueOn(rt, decl,
   * opts, { sources: "external" })` / `serveCollectionOn(rt, decl, opts)`.
   */
  serve?: (rt: ResourceRuntime) => void;
  /** `["METHOD /path/:param", handler]` pairs, e.g. `[ep.route, implement(ep, h)]`. */
  routes?: Parameters<typeof createRequestHandler>[0]["routes"];
  /**
   * The runtime's key set. Default `"closed"`, what every browser host boots
   * with (`bootBrowserHost`): an unknown key is refused `unserved`.
   */
  keySet?: () => "open" | "closed";
}

/**
 * A browser server over a resource runtime in this realm, wired as a browser
 * host is (`bootBrowserHost` + `runtimeBrowserServer`): the served
 * declarations, the given routes and `/api/resources/:key` through the shared
 * router, any other `/api` request the unsupported refusal
 * (`unmatchedApiResponse`).
 */
export function inRealmServer(opts: InRealmServerOptions = {}): BrowserServer {
  const rt = createResourceRuntime({
    keySet: opts.keySet ?? (() => "closed"),
  });
  opts.serve?.(rt);
  const request = createRequestHandler({
    routes: [
      ...(opts.routes ?? []),
      [RESOURCE_HTTP_ROUTE, rt.handleResourceHttp],
    ],
    onError: (err, req, pathname) => {
      console.error(`[in-realm server] ${req.method} ${pathname} threw:`, err);
    },
    onUnmatched: unmatchedApiResponse,
  });
  return runtimeBrowserServer({
    request,
    notifications: rt.notificationsWsHandler,
  });
}

/**
 * A host's `start`, as a scenario's `host.start` takes it, whose "worker" is
 * one end of an in-realm `MessageChannel`: the other end runs `serveOverPort`
 * over the server `boot` returns — or, when `boot` throws, reports the failure
 * (`PortHostBootError` on the page side), as a real worker whose graph fails
 * to boot does.
 */
export function channelHost(
  boot: () => BrowserServer | Promise<BrowserServer>,
): () => Promise<{ start(): Worker }> {
  return () =>
    Promise.resolve({
      start: () => {
        const channel = new MessageChannel();
        // `addEventListener` does not start a port; both ends must be.
        channel.port1.start();
        channel.port2.start();
        let served: BrowserServer | null = null;
        serveOverPort(channel.port2, async () => {
          served = await boot();
          return {
            server: served,
            keys: new Set<string>(),
            boot: { plugins: 0, stages: [], slowest: [] },
          };
        }).catch((err: unknown) => {
          // The page side already rejects with `PortHostBootError`; the
          // worker's own rethrow (its console stack) has no console here.
          if (!(err instanceof Error)) throw err;
        });
        const worker = {
          postMessage: (message: unknown, transfer?: Transferable[]) =>
            channel.port1.postMessage(message, transfer ?? []),
          addEventListener: (
            type: "message",
            listener: (event: MessageEvent) => void,
          ) => channel.port1.addEventListener(type, listener),
          terminate: () => {
            served?.dispose();
            channel.port1.close();
            channel.port2.close();
          },
        };
        // Only what `portBrowserServer` and the scope's teardown touch.
        return worker as unknown as Worker;
      },
    });
}
