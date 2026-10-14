// FIRST, and it must stay first: this declares the namespace this backend
// serves, from the `--namespace` the gateway spawned it with. Everything below
// reads that answer, and two modules in the closure resolve it at module eval
// (`plugins-active.ts`, `config_v2`'s config dir), so an import above this line
// boots the process without an identity. See `./declare-namespace`.
import "./declare-namespace";
import "./pin-toolchain";
import {
  profilerStart,
  recordMemoryCheckpoint,
  notificationsWsHandler,
  handleResourceHttp,
  reportServerError,
  markServerReady,
} from "@plugins/framework/plugins/server-core/core";
import type {
  WsData,
  HttpHandler,
  WsHandler,
  LoadedServerPlugin,
} from "@plugins/framework/plugins/server-core/core";
// The one boot sequence, shared with the `exec` mode. Everything below this
// import is what `serve` adds to it: the socket bind interleaved into the
// sequence, and the post-serving phases after it. See `shared/boot-stages.ts`
// for the mode split and `cli/run-exec.ts` for what `exec` skips.
import {
  bootPluginGraph,
  runAllReadyPhase,
  runGraphPhase,
  runShutdownHooks,
} from "../shared/boot-stages";
// The ACTIVE registry (which app is this backend?) and the on-disk plugins dir,
// resolved once for both boot modes.
import { serverEntries, hasCoreBarrel } from "./active-runtime";
import { boostInteractiveQos } from "@plugins/packages/plugins/spawn-priority/server";
import {
  isMain,
  readServingSocket,
} from "@plugins/infra/plugins/runtime-identity/core";
import { drainWarmups } from "@plugins/infra/plugins/warmup/server";
import { createRequestHandler } from "@plugins/framework/plugins/http-router/core";
import { RESOURCE_HTTP_ROUTE } from "@plugins/packages/plugins/resource-protocol/core";

// ── QoS boost (main backend only) ───────────────────────────────
// Raise the event-loop thread to user-interactive QoS BEFORE any boot work, so
// both boot and serving latency sit above default-priority bulk load (agent
// builds / type-check fleets) — the same scheduler tier that keeps GUI apps
// responsive during a build storm. STRICTLY main-only: isMain() is true only
// when the gateway spawned this backend with `--namespace singularity`;
// an agent-worktree backend runs this same code under its own worktree name
// and never qualifies. Boosting agent backends would lift the fleet above its
// own builds and defeat priority isolation. See
// research/perfs/2026-07-08-host-saturation-agent-checks-starve-main.md.
// SERVE ONLY: an `exec` child is background work spawned under a deliberately
// lowered priority, and boosting it would defeat that isolation.
if (isMain() && boostInteractiveQos()) {
  console.log(
    "[boot] main backend event-loop thread raised to user-interactive QoS",
  );
}

// ── Per-phase RSS attribution (boot Gantt) ──────────────────────
// We record a memory checkpoint at each clean boot-phase boundary below.
// CAVEAT: onReadyBlocking and onReady run their plugins under Promise.all, so
// the per-plugin (per-span) RSS deltas inside those phases overlap and are only
// *directional*. The phase-boundary checkpoints recorded here are the
// authoritative per-phase RSS numbers.
recordMemoryCheckpoint("boot-start");

// ── Route tables ────────────────────────────────────────────────
// Every plugin's HTTP routes go to the shared router (framework/http-router:
// literal fast path, then :param matching, the no-store default, the logged
// 500). WebSocket routes stay here: only this host upgrades sockets.
const wsRoutes: Record<string, WsHandler> = {};

function populateRoutes(
  ordered: LoadedServerPlugin[],
): (req: Request) => Promise<Response> {
  const end = profilerStart(
    "routePopulation",
    "routePopulation",
    "Route Population",
  );
  const httpRoutes: Array<[string, HttpHandler]> = [];
  for (const plugin of ordered) {
    if (plugin.httpRoutes)
      httpRoutes.push(...Object.entries(plugin.httpRoutes));
    if (plugin.wsRoutes) Object.assign(wsRoutes, plugin.wsRoutes);
  }

  // Core-owned routes for the live-state primitive.
  wsRoutes["/ws/notifications"] = notificationsWsHandler;
  httpRoutes.push([RESOURCE_HTTP_ROUTE, handleResourceHttp]);

  const handle = createRequestHandler({
    routes: httpRoutes,
    onError: (errObj, req, pathname) => {
      // Fail loudly: always emit a durable log line (captured by the gateway into
      // the per-worktree backend log) BEFORE returning a generic 500. The crash
      // report below is DB-backed and deduped — and is silently dropped during the
      // boot window before the reports plugin registers its reporter — so it can't
      // be the only signal.
      console.error(
        `[http] ${req.method} ${pathname}: ${errObj.message}`,
        errObj.stack ?? "",
      );
      reportServerError({
        message: `[http] ${req.method} ${pathname}: ${errObj.message}`,
        stack: errObj.stack ?? null,
        errorType: errObj.name,
      });
    },
  });
  end();
  return handle;
}

// ── Bind socket ─────────────────────────────────────────────────
// Bind immediately after migrations so the gateway detects readiness and
// starts proxying. onReady hooks run background work (graphile-worker DDL,
// git-log reconcile, file watchers, trigger setup) that isn't needed for
// serving HTTP/WS. Without this, the frontend loads instantly (static files)
// but stays stuck on "Server: Reconnecting" for the entire onReady phase.
//
// SERVE ONLY, and this is the one phase that interleaves INTO the shared boot
// sequence — hence `beforeReadyBarrier` below rather than a call after it.
// The socket is read here and nowhere else: an `exec` child has no socket and
// must not need one. It arrives as `--socket <path>` from the gateway
// (runtime-identity's readServingSocket, which also records it for code that
// must reach this backend over HTTP).
function bindSocket(ordered: LoadedServerPlugin[]): void {
  const handleHttp = populateRoutes(ordered);

  const socketPath = readServingSocket();

  const endSocketBind = profilerStart(
    "socketBind",
    "socketBind",
    "Socket Bind",
  );
  Bun.serve<WsData>({
    unix: socketPath,
    // Was Bun's default 10s. Under a host-saturation event-loop stall, an in-flight
    // HTTP handler or a WS-upgrade attempt writes no bytes for >10s and Bun drops it,
    // triggering a reconnect/resubscribe storm that amplifies the stall. This is a
    // gateway-fronted unix-socket-only listener, so 60s still reaps genuinely dead
    // HTTP conns within a minute while sitting above the gateway's load-scaled
    // readiness timeout. (The live WS is separately governed by the unset,
    // 120s-default websocket.idleTimeout — not this key.)
    idleTimeout: 60,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (req.headers.get("upgrade") === "websocket") {
        const handler = wsRoutes[url.pathname];
        if (handler) {
          server.upgrade(req, { data: { path: url.pathname } });
          return;
        }
      }

      return handleHttp(req);
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

  endSocketBind();
  console.log(`Server listening on ${socketPath}`);
}

// ── The shared boot sequence ────────────────────────────────────
// Load waves → register → collectContributions → the preload-declare assert →
// [bind socket] → the `onReadyBlocking` barrier. Identical to what `exec` runs,
// minus the bind.
const ordered = await bootPluginGraph({
  mode: "serve",
  entries: serverEntries,
  hasCoreBarrel,
  beforeReadyBarrier: bindSocket,
});
markServerReady();

// ── onReady ─────────────────────────────────────────────────────
// Phase 2 — onReady: eager graph-driven. Each plugin fires as soon as all
// its `dependsOn` parents have resolved — no artificial layer barriers.
// Plugins with no dependencies start immediately. `topoSortPlugins`
// guarantees every plugin appears after its deps in `ordered`, so
// `resolved.get(d.id)` is always defined when we reach a dependent.
await runGraphPhase(ordered, "onReady");
recordMemoryCheckpoint("after-onReady");

// ── onAllReady ──────────────────────────────────────────────────
await runAllReadyPhase(ordered);

// ── drainWarmups ────────────────────────────────────────────────
// Declared heavy boot warm-ups (infra/warmup) run LAST, after every phase has
// settled — the backend is already serving (since markServerReady), so the
// drain throttles itself (concurrency gate + host heavy-read slot + macrotask
// yield) and never competes with first requests. `host`-scoped warm-ups run
// only on main; a warm-up throw is logged, never fatal. Empty until a consumer
// declares one — this is the keystone the migrations land on.
{
  const end = profilerStart("drainWarmups", "drainWarmups", "Drain Warmups");
  try {
    await drainWarmups();
  } finally {
    end();
  }
}
recordMemoryCheckpoint("after-drainWarmups");

// Graceful shutdown: drain workers, flush state, release DB connections.
// Guarded against double-entry so both SIGTERM and a follow-up SIGINT can't
// run shutdown twice while the first pass is still draining.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received; shutting down`);
  await runShutdownHooks(ordered);
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

// Exit when orphaned (parent gateway died and we were reparented to init).
// macOS has no PR_SET_PDEATHSIG equivalent, so poll. Without this, old
// backends survive gateway crashes, leak PTYs, and hold onto ports.
if (process.ppid !== 1) {
  setInterval(() => {
    if (process.ppid === 1) process.exit(0);
  }, 2000).unref();
}
