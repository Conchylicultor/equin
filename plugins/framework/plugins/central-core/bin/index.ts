import type {
  WsData,
  HttpHandler,
  WsHandler,
  CentralPluginDefinition,
  LoadedCentralPlugin,
} from "@plugins/framework/plugins/central-core/core";
import {
  notificationsWsHandler,
  handleResourceHttp,
} from "@plugins/framework/plugins/central-core/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { centralEntries } from "../core/central.generated";
import {
  computeLoadWaves,
  topoSortPlugins,
} from "@plugins/framework/plugins/plugin-loader/core";
import { PLUGINS_DIR, toolchainPin } from "@plugins/infra/plugins/paths/core";
import { runtimePath } from "@plugins/infra/plugins/launcher/core";
import { readServingSocket } from "@plugins/infra/plugins/runtime-identity/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  centralRoutePrefixes,
  writeCentralRoutesManifest,
} from "./routes-manifest";

// Before any plugin loads (or spawns): a mise tool central runs resolves this
// checkout's locked toolchain whatever cwd it runs in. See `toolchainPin`.
// PATH re-normalised for the reason in server-core's `bin/pin-toolchain.ts`:
// the launching mise shim pinned its boot-time tool dirs in front again.
Object.assign(process.env, toolchainPin(), {
  PATH: runtimePath(process.env),
});

// ── Load all central plugins (topological waves) ───────────────
// Import in dependency-ordered waves over `dependsOn` rather than one flat
// `Promise.allSettled` over every entry. `dependsOn` is the codegen-derived
// cross-plugin import graph already carried by each entry (and already used to
// order the register/onReady phases below). Flat concurrent import races a
// barrel against a module that imports it: the dependent can evaluate while the
// barrel is suspended mid-re-export and observe the barrel's uninitialized
// `const` exports as a TDZ `ReferenceError` under Bun. Central runs under Bun
// from source (the gateway spawns it via the same backend-spawn path as worktree
// servers; there is no `--compile`), so it is exposed to exactly that race — the
// two auth leaves (auth.google / auth.notion) share a `core` dep and sit in the
// same final wave, the precise concurrent first-eval the warming step closes.
// Loading wave-by-wave (concurrent WITHIN a wave, serialized only across edges)
// guarantees a plugin's imports are fully evaluated before it is imported. See
// `computeLoadWaves` for the invariant and cycle handling.
const waves = computeLoadWaves(centralEntries);
const byPath = new Map<string, LoadedCentralPlugin>();
const seenIds = new Set<string>();
// Collect ALL load failures across every wave and throw once at the end — the
// operator needs the full list, not just the first plugin to blow up.
const loadFailures: Array<{ pluginPath: string; error: string }> = [];
// A plugin exposes a public `core` barrel iff `plugins/<path>/core/index.ts`
// exists (`PLUGINS_DIR` is derived from this file's own location, not cwd).
const hasCoreBarrel = (pluginPath: string): boolean =>
  existsSync(join(PLUGINS_DIR, pluginPath, "core", "index.ts"));
for (const wave of waves) {
  // ── Warm this wave's core barrels BEFORE loading its central barrels ──
  // Parity with the server loader, kept as forward-safe insurance. Central's
  // cross-plugin imports go through the `core` *barrel index* (the boundary rule
  // permits only `@plugins/<name>/core`, never a core submodule), so whenever a
  // dependency has its own `central` barrel, loading that barrel in an earlier
  // wave already evaluates its core index — for the current graph wave-ordering
  // alone closes the race (unlike the server, whose barrels import core
  // *submodules*, leaving the core index cold). The gap this warming closes is a
  // *core-only* dependency (no `central` barrel) whose core index is imported by
  // two central plugins in the SAME wave: nothing else would evaluate it before
  // both race its first import. Warming each wave's cores here — concurrently,
  // since every core they transitively import belongs to an already-evaluated
  // earlier wave — makes that impossible. Rejections here are not the reporting
  // site: a genuinely broken core re-rejects when its own (or a dependent's)
  // central barrel imports it below, and is recorded there — nothing is swallowed.
  const coreWave = wave.filter((e) => hasCoreBarrel(e.pluginPath));
  await Promise.allSettled(
    coreWave.map((e) => import(`@plugins/${e.pluginPath}/core`)),
  );

  const results = await Promise.allSettled(
    wave.map(
      (e) => e.loader() as Promise<{ default: CentralPluginDefinition }>,
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const e = wave[i]!;
    if (r.status === "rejected") {
      console.error(`[plugin.${e.pluginPath}] load failed`, r.reason);
      // First line of the error (`Name: message`) for the aggregated summary;
      // the full reason/stack is on the console.error line above.
      loadFailures.push({
        pluginPath: e.pluginPath,
        error: String(r.reason).split("\n")[0]!,
      });
      continue;
    }
    // `id` is derived from the unique hierarchy path, never authored. The guard
    // is structurally unreachable but fails loud if codegen ever produces a
    // collision, rather than letting topo sort silently drop a plugin.
    if (seenIds.has(e.id)) {
      throw new Error(
        `[plugin] duplicate derived plugin id "${e.id}" (${e.pluginPath})`,
      );
    }
    seenIds.add(e.id);
    const plugin = r.value.default as LoadedCentralPlugin;
    plugin.id = asPluginId(e.id);
    byPath.set(e.pluginPath, plugin);
  }
}
// Central is a single host-wide process, so a plugin that cannot load MUST NOT
// let central come up degraded across every worktree. A module that throws at
// import time is broken, full stop — aggregate every failure into one error so
// the whole list is visible, and crash rather than serve a half-loaded central.
if (loadFailures.length > 0) {
  throw new Error(
    `[plugin] ${loadFailures.length} plugin(s) failed to load:\n` +
      loadFailures.map((f) => `  - ${f.pluginPath}: ${f.error}`).join("\n"),
  );
}
for (const e of centralEntries) {
  const plugin = byPath.get(e.pluginPath);
  if (!plugin) continue;
  plugin.dependsOn = e.dependsOn
    .map((p) => byPath.get(p))
    .filter((d): d is LoadedCentralPlugin => d !== undefined);
}
const ordered = topoSortPlugins([...byPath.values()]);

// Phase 1 — register: sequential, topo-sorted. Each plugin's `register`
// array holds Registration tokens; the framework calls `.register()` on
// each in order. See server/src/index.ts for the same pattern.
for (const p of ordered) {
  for (const r of p.register ?? []) {
    try {
      await r.register();
    } catch (err) {
      console.error(`[plugin.${p.id}] register failed`, err);
      throw err;
    }
  }
}

await Promise.all(
  ordered.map((p) =>
    Promise.resolve()
      .then(() => p.onReady?.())
      .catch((err) => {
        console.error(`[plugin.${p.id}] onReady failed`, err);
        if (p.loadBearing) throw err;
      }),
  ),
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[central] ${signal} received; shutting down`);
  await Promise.all(
    ordered.map((p) =>
      // eslint-disable-next-line promise-safety/no-bare-catch
      Promise.resolve()
        .then(() => p.onShutdown?.())
        .catch((err) =>
          console.error(`[plugin.${p.id}] onShutdown failed`, err),
        ),
    ),
  );
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

if (process.ppid !== 1) {
  setInterval(() => {
    if (process.ppid === 1) process.exit(0);
  }, 2000).unref();
}

interface ParamRoute<H> {
  segments: Array<{ literal: string } | { param: string }>;
  handler: H;
}
interface HttpParamRoute extends ParamRoute<HttpHandler> {
  method: string;
}
const literalHttpRoutes: Record<string, HttpHandler> = {};
const paramHttpRoutes: HttpParamRoute[] = [];
const wsRoutes: Record<string, WsHandler> = {};
// Every HTTP route key registered, as written (`"GET /api/auth/state"`) — the
// source of the routing manifest published once the server is listening.
const httpRouteKeys: string[] = [];

function pathSegments(
  path: string,
): Array<{ literal: string } | { param: string }> {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(":") ? { param: s.slice(1) } : { literal: s }));
}

function registerHttpRoute(key: string, handler: HttpHandler) {
  httpRouteKeys.push(key);
  const spaceIdx = key.indexOf(" ");
  const method = key.slice(0, spaceIdx);
  const path = key.slice(spaceIdx + 1);
  if (!path.includes("/:")) {
    literalHttpRoutes[`${method} ${path}`] = handler;
    return;
  }
  paramHttpRoutes.push({ method, segments: pathSegments(path), handler });
}

function matchSegments<H>(
  pathname: string,
  routes: ParamRoute<H>[],
  filter: (r: ParamRoute<H>) => boolean = () => true,
): { handler: H; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter((s) => s.length > 0);
  for (const route of routes) {
    if (!filter(route)) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i]!;
      const part = parts[i]!;
      if ("literal" in seg) {
        if (seg.literal !== part) {
          ok = false;
          break;
        }
      } else {
        params[seg.param] = decodeURIComponent(part);
      }
    }
    if (ok) return { handler: route.handler, params };
  }
  return null;
}

for (const plugin of ordered) {
  if (plugin.httpRoutes) {
    for (const [key, handler] of Object.entries(plugin.httpRoutes)) {
      registerHttpRoute(key, handler);
    }
  }
  if (plugin.wsRoutes) Object.assign(wsRoutes, plugin.wsRoutes);
}

// Core-owned routes for the live-state primitive on the central runtime.
// Browsers reach these paths via the gateway's central-routes manifest, which
// this process publishes below — so they are listed like any plugin route.
wsRoutes["/ws/central-notifications"] = notificationsWsHandler;
registerHttpRoute("GET /api/central-resources/:key", handleResourceHttp);

// The socket the gateway handed this backend, as `--socket <path>` (with a
// transition fallback to the old environment variable — see
// runtime-identity's serving-socket.ts).
const socketPath = readServingSocket();

// Default every API response to `cache-control: no-store` unless the handler set
// its own — the dispatch-layer floor beneath handleResourceHttp's own explicit
// `no-store` that closes the cache-poisoning wedge class on central too (Fix E).
// Bun's constructed-Response headers are mutable in place (probed), so no clone.
function withDefaultCacheControl(res: Response): Response {
  if (!res.headers.has("cache-control"))
    res.headers.set("cache-control", "no-store");
  return res;
}

// Central had no try/catch around handler dispatch — a throw surfaced as Bun's
// default 500 with no log line. Mirror server-core's `safeHandle` (console.error
// with method + pathname + stack → generic 500); central has no reportServerError
// hook, so the console line is the parity floor. Also applies the Cache-Control
// default so both the success and error responses go through one chokepoint.
async function safeHandle(
  handler: HttpHandler,
  req: Request,
  params: Record<string, string>,
  pathname: string,
): Promise<Response> {
  try {
    return withDefaultCacheControl(await handler(req, params));
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[http] ${req.method} ${pathname}: ${errObj.message}`,
      errObj.stack ?? "",
    );
    return withDefaultCacheControl(
      Response.json({ error: "Internal server error" }, { status: 500 }),
    );
  }
}

const server = Bun.serve<WsData>({
  unix: socketPath,
  fetch(req, server) {
    const url = new URL(req.url);

    if (req.headers.get("upgrade") === "websocket") {
      const handler = wsRoutes[url.pathname];
      if (handler) {
        server.upgrade(req, { data: { path: url.pathname } });
        return;
      }
    }

    const literal = literalHttpRoutes[`${req.method} ${url.pathname}`];
    if (literal) return safeHandle(literal, req, {}, url.pathname);

    const matched = matchSegments(
      url.pathname,
      paramHttpRoutes,
      (r) => (r as HttpParamRoute).method === req.method,
    );
    if (matched)
      return safeHandle(matched.handler, req, matched.params, url.pathname);

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsRoutes[ws.data.path]?.open(ws);
    },
    message(ws, msg) {
      wsRoutes[ws.data.path]?.message(ws, msg);
    },
    close(ws, code, reason) {
      wsRoutes[ws.data.path]?.close(ws, code, reason);
    },
  },
});

// Tell the gateway which paths are ours, now that something is listening for
// them. Written from the route tables above, so the list always matches the
// code this process runs — whichever checkout last built cannot change it.
writeCentralRoutesManifest(
  centralRoutePrefixes(httpRouteKeys, Object.keys(wsRoutes)),
);

console.log(`Central listening on :${server.port}`);
