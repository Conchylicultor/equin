import type { ServerWebSocket } from "bun";

export interface WsData {
  path: string;
}

export interface WsHandler {
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, msg: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>, code: number, reason: string): void;
}

export type HttpHandler = (
  req: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

declare const machineHandlerBrand: unique symbol;

/**
 * An HTTP handler that may only be served by a plugin's `machine/` half: one
 * implementing an endpoint declared desktop-only (`needsMachine`), so every
 * client already handles its "not available" answer on a host without the
 * computer. Minted only by the endpoints primitive's machine barrel
 * (`implementMachine`), and the only handler `MachinePluginDefinition`'s
 * `httpRoutes` accepts — so a portable endpoint cannot be served by machine code
 * alone, which would be a silent 404 on every other host.
 */
export type MachineHttpHandler = HttpHandler & {
  readonly [machineHandlerBrand]: true;
};

/**
 * An HTTP handler a `server/` barrel serves: any handler but a
 * `MachineHttpHandler` — a desktop-only endpoint's handler is served by its
 * plugin's `machine/` half, never by the portable one (tsc).
 */
export type PortableHttpHandler = HttpHandler & {
  readonly [machineHandlerBrand]?: never;
};

declare const endpointHandlerBrand: unique symbol;

/**
 * An HTTP handler built by the endpoints primitive (`implement` /
 * `implementMachine`, or its raw `endpointRawHandler`): one that reads its
 * endpoint's declaration before the handler runs — the agent-write gate that
 * refuses an agent session's write on main among it
 * (`research/2026-10-22-global-main-read-only-for-agent-sessions.md`). Minted
 * only by `infra/endpoints`; the brand is type-only.
 */
export type EndpointHttpHandler = HttpHandler & {
  readonly [endpointHandlerBrand]: true;
};

/** What `implementMachine` (and the machine barrel's raw `machineHandler`) mints. */
export type MachineEndpointHttpHandler = MachineHttpHandler &
  EndpointHttpHandler;

/** Methods that cannot write: their routes take any handler. */
type SafeHttpMethod = "GET" | "HEAD" | "OPTIONS";
/** Methods that may write: their routes take only an {@link EndpointHttpHandler}. */
type WriteHttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A barrel's `httpRoutes`: `"METHOD /path"` → handler. A write route (POST /
 * PUT / PATCH / DELETE) takes only an {@link EndpointHttpHandler}, so a raw
 * handler cannot serve a write and skip the gates the endpoint declaration
 * drives (tsc) — a key of any other shape is no route at all.
 */
export type HttpRoutes<H extends HttpHandler> = {
  [route: `${SafeHttpMethod} ${string}`]: H;
  [route: `${WriteHttpMethod} ${string}`]: H & EndpointHttpHandler;
};

// Opaque handle for a resource defined via `defineResource`. The concrete
// `Resource<T, P>` type lives in ./resources; kept minimal here to avoid a
// circular import.
export type ResourceLike = { key: string };

export type { DocMeta } from "@plugins/framework/plugins/web-sdk/core";

import type { DocMeta } from "@plugins/framework/plugins/web-sdk/core";

/**
 * A lazy registry write. Returned by helpers like `Mcp.tool`, `Runtime.define`,
 * `defineJob`, `defineTriggerEvent`, and `UNSAFE_installDurableHooks`. The
 * framework walks `plugin.register: Registration[]` during the register phase
 * and invokes `.register()` on each token in topo-sorted order.
 *
 * Dual-purpose factories (`defineJob`, `defineTriggerEvent`'s `event` field)
 * implement Registration alongside their public API on the same object —
 * `const dispatchJob = defineJob({...})` exposes `.enqueue` (factory role)
 * and `.register()` (framework hook).
 */
export interface Registration {
  register(): void | Promise<void>;
  /** Auto-set by the factory (e.g. "mcp-tool", "job"). Never manually specified. */
  readonly _kind?: string;
  /** Factory function name for docgen display (e.g. "defineJob", "mcpTool"). Auto-set. */
  readonly _factory?: string;
  _doc?: DocMeta;
}

export type { ServerContribution, ServerContributionToken } from "./contributions";

/**
 * Authored server-plugin shape. `id` is deliberately absent — it is derived
 * from the plugin's unique hierarchy path and injected by the loader (see
 * {@link LoadedServerPlugin}), never hand-authored. There is likewise no human
 * `name`: the derived id is the sole identity (see `PluginDefinition`).
 */
export interface ServerPluginDefinition {
  description?: string;
  /**
   * Marks the plugin as critical core infrastructure. See
   * `PluginDefinition.loadBearing` in `plugin-core/types.ts` for semantics.
   */
  loadBearing?: boolean;
  collapsed?: boolean;
  httpRoutes?: HttpRoutes<PortableHttpHandler>;
  wsRoutes?: Record<string, WsHandler>;
  /**
   * Plugins this plugin's `register` array must run after. Most plugins need
   * this empty: phase ordering (all `register` writes before any `onReady`)
   * handles the registry-host case automatically. Use only when this
   * plugin's `register` tokens read state another plugin's `register` tokens
   * produced.
   */
  dependsOn?: ServerPluginDefinition[];
  /**
   * Lazy registry-write tokens applied at boot before `runMigrations()` and
   * `onReady()`. The only place a plugin writes to global registries
   * (`Mcp.tool`, `Runtime.define`, `defineJob`, `defineTriggerEvent`,
   * `UNSAFE_installDurableHooks`). Each token's `.register()` is called
   * sequentially in topo-sorted order, so registries are fully populated
   * before `onReady()` fires. No I/O, no DB queries — those belong in
   * `onReady`.
   */
  register?: Registration[];
  /**
   * Runs after the socket binds but BEFORE the server reports ready and before
   * any plugin's `onReady`. The phase is graph-driven by `dependsOn` (exactly
   * like `onReady`): a plugin's blocking hook starts only after all its
   * `dependsOn` parents' blocking hooks have resolved — so a DB-touching plugin
   * (which necessarily imports `database`) auto-sequences after migrations with
   * no per-plugin workaround. The whole phase is still a hard barrier: the
   * framework awaits every plugin's `onReadyBlocking`, then flips the readiness
   * flag (`isServerReady`) that `GET /api/health/ready` reports and the gateway
   * gates its hot-swap on. Use ONLY for work that must complete before the
   * backend can correctly serve requests — DB migrations + pool warmup, registry
   * init. Everything else (pollers, watchers, reconcilers) belongs in `onReady`.
   *
   * A throw here ALWAYS aborts boot — for every plugin, NOT just `loadBearing`
   * ones. This is a hard barrier: the whole reason work lives here rather than in
   * `onReady` is that it must complete before the backend can serve correctly, so
   * a failure to complete is fatal by definition. (`loadBearing` classifies docs
   * detail / criticality, not barrier participation.) If a plugin's blocking work
   * is genuinely optional-for-correctness — a failure should DEGRADE, not crash —
   * it must handle its own error INSIDE the hook (catch + log + continue), making
   * the degradation explicit and co-located with the code that understands the
   * failure mode. Do NOT rely on the framework to swallow the throw. Because this
   * is a barrier, every `onReady` is guaranteed to observe a migrated DB and a
   * ready registry.
   */
  onReadyBlocking?: () => void | Promise<void>;
  /**
   * Called once after `onReadyBlocking` has completed across all plugins (so a
   * migrated DB and ready registry are guaranteed). Use this for background
   * work (pollers, watchers) that issues DB queries — scheduling it from the
   * plugin's module body races the migration runner.
   */
  onReady?: () => void | Promise<void>;
  /**
   * Called once after EVERY plugin's `onReady` has resolved (a full barrier,
   * not dependency-scoped). Use this for initialization that must observe
   * state another plugin only produces in its `onReady` and that you can't
   * express as a `dependsOn` edge — e.g. building schedules whose definitions
   * read config the config plugin populates in its own `onReady`. Runs in
   * parallel across plugins; a load-bearing plugin's rejection aborts boot.
   */
  onAllReady?: () => void | Promise<void>;
  /**
   * Called once on SIGTERM/SIGINT before the process exits. Use this to drain
   * background workers, flush buffered state, and release DB connections.
   * Run in parallel across plugins (same contract as `onReady`); rejections
   * are logged but do not block other plugins' shutdown.
   */
  onShutdown?: () => void | Promise<void>;
  contributions?: import("./contributions").ServerContribution[];
  /**
   * "This plugin's server closure runs on every host": its `server/index.ts`
   * statically reaches no platform API (a Node builtin, `bun`, `pg`, graphile,
   * a native watcher), measured transitively by `boundaries:portable-closure`.
   * The browser host loads only plugins that declare it.
   *
   * Transitional: once no `server/` file carries a `boundaries/no-platform-api`
   * debt exemption, every server barrel is portable and the flag is deleted.
   */
  portable?: true;
}

/**
 * The authored shape of a plugin's `machine/` barrel — its desktop-only half,
 * booted in the same graph as the server entries as the node
 * `<pluginPath>#machine` (after its own server half). It is a server plugin in
 * every way but two: it cannot claim `portable` (it is the code that is not),
 * and its `httpRoutes` take only `MachineHttpHandler`s.
 */
export type MachinePluginDefinition = Omit<
  ServerPluginDefinition,
  "httpRoutes" | "portable"
> & {
  httpRoutes?: HttpRoutes<MachineHttpHandler>;
};

/**
 * A server plugin at runtime: the authored shape plus the loader-injected
 * identity. `id` equals the unique hierarchy path; `dependsOn` is narrowed to
 * other loaded plugins (resolved by the loader, never authored). Framework
 * readers operate on this type so `p.id` is always a defined string.
 */
export type LoadedServerPlugin = Omit<ServerPluginDefinition, "dependsOn"> & {
  id: string;
  dependsOn?: LoadedServerPlugin[];
};
