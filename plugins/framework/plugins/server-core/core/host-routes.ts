import { RESOURCE_HTTP_ROUTE } from "@plugins/network/plugins/live/plugins/resource-protocol/core";
import type { SocketAccess } from "@plugins/framework/plugins/principal/core";
import { handleResourceHttp } from "./resources";
import type { HttpHandler, LoadedServerPlugin } from "./types";

/**
 * Why a deployed site's visitors (principal `visitor`) reach the live-state
 * read and socket: every page boots and stays live through them, and on a
 * deployed site those pages are the visitors'. They serve the resources of
 * the composition the site runs — what its pages read — and stay closed to a
 * foreign page (anonymous) on any host.
 */
export const LIVE_STATE_VISITOR_REASON =
  "every page of a deployed site boots and stays live through it; it serves the resources of the composition the site runs";

/** The core-owned live-state socket's access (`/ws/notifications`). */
export const LIVE_STATE_SOCKET_ACCESS: SocketAccess = {
  visitor: LIVE_STATE_VISITOR_REASON,
};

/**
 * Every HTTP route a booted graph serves: each plugin's `httpRoutes`, in boot
 * order, plus the core-owned live-state read (`GET /api/resources/:key`). The
 * one route table both hosts mount — the desktop backend's socket
 * (`bin/index.ts`) and the browser worker (`./browser-host.ts`) — each through
 * `createRequestHandler` with its own error sink.
 */
export function hostHttpRoutes(
  ordered: readonly LoadedServerPlugin[],
): Array<[string, HttpHandler]> {
  const routes: Array<[string, HttpHandler]> = [];
  for (const plugin of ordered) {
    if (plugin.httpRoutes) routes.push(...Object.entries(plugin.httpRoutes));
  }
  routes.push([
    RESOURCE_HTTP_ROUTE,
    Object.assign(
      (req: Request, params: Record<string, string>) =>
        handleResourceHttp(req, params),
      { access: { visitor: LIVE_STATE_VISITOR_REASON } },
    ),
  ]);
  return routes;
}
