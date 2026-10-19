import { RESOURCE_HTTP_ROUTE } from "@plugins/packages/plugins/resource-protocol/core";
import { handleResourceHttp } from "./resources";
import type { HttpHandler, LoadedServerPlugin } from "./types";

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
  routes.push([RESOURCE_HTTP_ROUTE, handleResourceHttp]);
  return routes;
}
