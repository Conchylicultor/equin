import type { ServerWebSocket } from "bun";

export interface WsData {
  path: string;
}

export interface WsHandler {
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, msg: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>, code: number, reason: string): void;
  /** The socket's send queue drained after a `send` hit backpressure. */
  drain?(ws: ServerWebSocket<WsData>): void;
}

export type HttpHandler = (
  req: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

export type ResourceLike = { key: string };

/**
 * A lazy registry write. Same semantics as `ServerPluginDefinition`'s
 * `Registration`. See `server/src/types.ts` for the full contract.
 */
export interface Registration {
  register(): void | Promise<void>;
}

/**
 * Authored central-plugin shape. `id` is deliberately absent — it is derived
 * from the plugin's unique hierarchy path and injected by the loader (see
 * {@link LoadedCentralPlugin}), never hand-authored. There is likewise no human
 * `name`: the derived id is the sole identity (see `PluginDefinition`).
 */
export interface CentralPluginDefinition {
  description?: string;
  /**
   * Marks the plugin as critical core infrastructure. See
   * `PluginDefinition.loadBearing` in `plugin-core/types.ts` for semantics.
   */
  loadBearing?: boolean;
  collapsed?: boolean;
  httpRoutes?: Record<string, HttpHandler>;
  wsRoutes?: Record<string, WsHandler>;
  resources?: ResourceLike[];
  /**
   * Plugins this plugin's `register` array must run after. Same semantics as
   * `ServerPluginDefinition.dependsOn`.
   */
  dependsOn?: CentralPluginDefinition[];
  /**
   * Lazy registry-write tokens applied at boot before `onReady()`. Sequential,
   * topo-sorted. Use for registry writes only; no I/O.
   */
  register?: Registration[];
  onReady?: () => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
}

/**
 * A central plugin at runtime: the authored shape plus the loader-injected
 * identity. `id` equals the unique hierarchy path; `dependsOn` is narrowed to
 * other loaded plugins. Framework readers operate on this type.
 */
export type LoadedCentralPlugin = Omit<CentralPluginDefinition, "dependsOn"> & {
  id: string;
  dependsOn?: LoadedCentralPlugin[];
};
