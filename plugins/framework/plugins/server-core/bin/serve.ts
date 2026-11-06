// The serving backend — `serve`, the long-lived gateway-spawned boot mode. Not
// an entry itself: a composition's entry (`./index.ts` for the main one, a
// generated `index.composition.<id>.generated.ts` for any other — codegen's
// `renderBackendEntry`) imports its registries by literal path and calls
// `serve` with them, so which app this process is was decided by the file the
// spec's `command` ran, and the code it runs is a closure a source digest can
// follow (research/2026-11-05-global-backend-code-identity.md).
import {
  BOOT_JOURNAL_CHANNEL,
  installBootJournal,
  profilerStart,
  recordMemoryCheckpoint,
  notificationsWsHandler,
  hostHttpRoutes,
  reportServerError,
  markServerReady,
  handOffEpoch,
} from "@plugins/framework/plugins/server-core/core";
import type {
  WsData,
  WsHandler,
  LoadedServerPlugin,
} from "@plugins/framework/plugins/server-core/core";
// The one boot sequence, shared with the `exec` mode. Everything below this
// import is what `serve` adds to it: the socket bound before it (503 until the
// routes go in), the route install interleaved into the sequence, and the
// post-serving phases after it. See `core/boot-stages.ts`
// for the mode split and `cli/run-exec.ts` for what `exec` skips.
import {
  bootPluginGraph,
  runPostReadyPhases,
  runSettledPhase,
  runShutdownHooks,
} from "../core/boot-stages";
import { installProcessCrashListeners } from "../core/process-crash-listeners";
// The desktop's native probes (memory, snapshot hash), installed into `core`
// before the graph loads — see `./host-probes`.
import "./host-probes";
import { worktreesDir } from "@plugins/infra/plugins/paths/core";
import {
  assertServesComposition,
  readSpecComposition,
} from "./spec-composition";
import {
  boostInteractiveQos,
  followGatewayBootTier,
  leaveDarwinBackground,
  readDarwinBackground,
} from "@plugins/packages/plugins/spawn-priority/server";
import {
  isMain,
  readServingSocket,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { recordFsWaits } from "@plugins/debug/plugins/profiling/plugins/fs-wait/server";
import { writeBootStartEvent } from "@plugins/debug/plugins/boot-events/server";
import { markOwnBootUnsettled } from "@plugins/debug/plugins/boot-events/machine";
import { createRequestHandler } from "@plugins/framework/plugins/http-router/core";
import {
  channelFileSink,
  logEnvelope,
} from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";
import {
  HOST_ROUTES_ROUTE,
  hostGateFromArgv,
  type HostGate,
} from "@plugins/framework/plugins/principal/core";

/** One composition's server and machine registries, as its entry imports them. */
export interface BackendRegistries {
  server: typeof import("../core/server.generated");
  machine: typeof import("../core/machine.generated");
}

export async function serve({
  server,
  machine,
}: BackendRegistries): Promise<void> {
  // ── Crash listeners ─────────────────────────────────────────────
  // First, so a throw anywhere below is caught: the framework's listeners,
  // dispatching to `processCrashSink` (`core/process-crash-listeners.ts`). `runExec`
  // installs the same ones, so an exec child's crash is filed too.
  installProcessCrashListeners();

  // ── Slow file calls (fs-wait) ───────────────────────────────────
  // A process root names its own fs-wait record, once: this one is a serving
  // backend. The CLI root (`framework/cli/bin/cli.ts`) does the same for every
  // `./equin <verb>`, which is also where an `exec` boot (`runExec`) runs — so
  // the plugin graph never names the process, and no process gets two names.
  recordFsWaits({ process: "backend", namespace: runtimeNamespace() });

  // ── QoS boost (main backend only) ───────────────────────────────
  // Raise the event-loop thread to user-interactive QoS BEFORE any boot work, so
  // both boot and serving latency sit above default-priority bulk load (agent
  // builds / type-check fleets) — the same scheduler tier that keeps GUI apps
  // responsive during a build storm. STRICTLY main-only: isMain() is true only
  // when the gateway spawned this backend with `the main namespace`;
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
  // ── Boot journal (durable, as it accrues) ───────────────────────
  // The boot profile lives in memory and is lost with a backend killed before
  // ready — the gateway's readiness deadline is a SIGKILL, which runs no handler.
  // So every checkpoint, every load wave as it opens (with its plugins) and each
  // slow span is also appended, synchronously, to the boot-journal channel:
  // the last `open` with no closing `span` is the step a killed boot died in.
  // SERVE ONLY, installed before the first checkpoint and the plugin graph.
  const bootJournal = channelFileSink({
    id: BOOT_JOURNAL_CHANNEL,
    description:
      "Per-boot journal of a serving backend's boot profile, written as it accrues: phase checkpoints, each plugin load wave as it opens (with its plugins), and every slow span — so a backend killed before ready still says where it was.",
  });
  const processStartedAt = Math.round(performance.timeOrigin);
  installBootJournal((entry) => {
    bootJournal.append(
      logEnvelope({
        t: Date.now(),
        stream: "stdout",
        line: JSON.stringify({ processStartedAt, entry }),
      }),
    );
  });

  recordMemoryCheckpoint("boot-start");
  // This boot's `start` line and unsettled mark (boot-events), before any
  // plugin import: a boot killed while importing still counts as an attempt,
  // and the boot watchdog still reads its worktree (see writeBootStartEvent).
  writeBootStartEvent();
  markOwnBootUnsettled(runtimeNamespace());

  // ── Which app (before the socket binds) ─────────────────────────
  // The entry that imported these registries names one composition; the
  // namespace's spec.json names the one it serves. They must agree: an entry
  // that is not the namespace's — a spec written before this entry existed, a
  // gateway falling back to `bin/index.ts` — would boot one app under another's
  // namespace and database, which looks like it worked. See `./spec-composition`.
  // After the `start` line and unsettled mark, so a refused boot still counts
  // as an attempt the boot watchdog reports; before anything binds or loads.
  assertServesComposition(
    readSpecComposition(worktreesDir(), runtimeNamespace()),
    [server.composition.id, machine.composition.id],
  );

  // Which tier this boot starts in, journaled: a background-started backend
  // boots darwinbg (gateway `taskpolicy -b`) until the gateway's probe says
  // otherwise (`left-darwinbg` below) or it is ready — so a slow boot's journal
  // says how much of it ran demoted.
  if (readDarwinBackground().kind === "darwinbg") {
    recordMemoryCheckpoint("darwinbg-at-start");
  }

  // ── Route tables ────────────────────────────────────────────────
  // Every plugin's HTTP routes go to the shared router (framework/http-router:
  // literal fast path, then :param matching, the no-store default, the logged
  // 500). WebSocket routes stay here: only this host upgrades sockets.
  const wsRoutes: Record<string, WsHandler> = {};

  function populateRoutes(
    ordered: LoadedServerPlugin[],
    gate: HostGate,
  ): (req: Request) => Promise<Response> {
    const end = profilerStart(
      "routePopulation",
      "routePopulation",
      "Route Population",
    );
    for (const plugin of ordered) {
      if (plugin.wsRoutes) Object.assign(wsRoutes, plugin.wsRoutes);
    }

    // Core-owned socket for the live-state primitive.
    wsRoutes["/ws/notifications"] = notificationsWsHandler;

    const handle = createRequestHandler({
      // Plugin routes + the live-state read (the table the browser host mounts
      // too), plus this socket's own route table (`GET /api/host/routes`) — each
      // behind the principal gate: an anonymous caller (the gateway's verdict)
      // reaches only a route declared `access: { public }` — when the gateway
      // declared it stamps the principal (`--principal-stamped`; ungated, and
      // loudly so, behind an older gateway). Not the browser host: its only
      // caller is the page itself.
      routes: gate.routes({
        tableRoute: HOST_ROUTES_ROUTE,
        http: hostHttpRoutes(ordered),
        wsPaths: Object.keys(wsRoutes),
      }),
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

  // ── Install routes ──────────────────────────────────────────────
  // The socket is already open (below, before the plugin graph loads), answering
  // 503 to everything. Once the graph is loaded and its contributions collected,
  // the routes go in here — before the `onReadyBlocking` barrier, so the frontend
  // reaches the backend for the whole barrier + onReady phase instead of sitting
  // on "Server: Reconnecting" (`/api/health/ready` itself stays 503 until the
  // barrier completes). This is the one serve-only phase that interleaves INTO
  // the shared boot sequence — hence `beforeReadyBarrier` rather than a call
  // after it.
  function installRoutes(ordered: LoadedServerPlugin[]): void {
    handleHttp = populateRoutes(ordered, gate);
    console.log(`[boot] routes installed on ${socketPath}`);
  }

  // ── Bind socket, FIRST ──────────────────────────────────────────
  // The socket opens before the plugin graph loads and answers every request
  // with 503 until `installRoutes` swaps the real router in. The gateway reads
  // ANY HTTP answer as "alive and mid-boot": past its base readiness deadline it
  // extends the wait instead of killing (gateway/worktree.go's waitReady). A
  // backend that bound only after loading every plugin wave answered nothing
  // before that deadline, read as wedged and was SIGKILLed — on 2026-11-04 main's
  // load waves took ~13 s, its boot sat just past the 15 s base, and every main
  // hot restart but one failed. A boot that throws still exits at once (an open
  // server does not keep a failed entry-module evaluation alive), so the gateway
  // still sees a crash instantly; only a boot that hangs now waits out the
  // escalated deadline instead of the base one.
  //
  // SERVE ONLY: the socket is read here and nowhere else — an `exec` child has
  // no socket and must not need one. It arrives as `--socket <path>` from the
  // gateway (runtime-identity's readServingSocket, which also records it for code
  // that must reach this backend over HTTP).
  //
  // Does the gateway stamp the principal? Its `--principal-stamped` on argv says
  // so; without it the gate is off (see principal's `core/stamp.ts`).
  const gate = hostGateFromArgv(process.argv);
  const socketPath = readServingSocket(process.argv);
  // null until `installRoutes`: the plugin graph is still loading.
  let handleHttp: ((req: Request) => Promise<Response>) | null = null;
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
      // The gateway's word on this boot's priority, on its readiness probe: a
      // background-started backend boots darwinbg until the gateway says
      // foreground (a browser joined, or the boot escalated), and only this
      // process can move itself (spawn-priority's `followGatewayBootTier`). Ahead
      // of everything, so it lands while the plugin graph is still loading.
      const moved = followGatewayBootTier(req);
      if (moved) {
        console.log(
          `[boot] scheduling tier on the gateway's word: ${moved.kind === "unsupported" ? `unsupported (${moved.reason})` : moved.kind}`,
        );
        recordMemoryCheckpoint("left-darwinbg");
      }

      // Still loading the plugin graph: no route exists yet, the readiness
      // probe included. Not ready, but alive — which is what the gateway reads.
      if (!handleHttp) {
        return Response.json(
          { error: "server not ready: loading plugins" },
          { status: 503 },
        );
      }

      const url = new URL(req.url);

      // WebSocket upgrade
      if (req.headers.get("upgrade") === "websocket") {
        const handler = wsRoutes[url.pathname];
        if (handler) {
          // No socket is public: an anonymous upgrade is refused here too,
          // behind the gateway's own refusal.
          const refused = gate.refuseUpgrade(req, url.pathname);
          if (refused) return refused;
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
      drain(ws) {
        wsRoutes[ws.data.path]?.drain?.(ws);
      },
    },
  });
  endSocketBind();
  console.log(`Server listening on ${socketPath}`);

  // ── The shared boot sequence ────────────────────────────────────
  // Load waves → register → collectContributions → the preload-declare assert →
  // [install routes] → the `onReadyBlocking` barrier. Identical to what `exec`
  // runs, minus the route install (and the socket bound above).
  const ordered = await bootPluginGraph({
    mode: "serve",
    // A desktop host boots both halves of every plugin as one graph.
    entries: [...server.serverEntries, ...machine.machineEntries],
    beforeReadyBarrier: installRoutes,
  });
  markServerReady();

  // ── Leave darwinbg (every backend, once ready) ───────────────────
  // The gateway spawns a background-started backend under `taskpolicy -b` so its
  // boot burst cannot starve main, and means it to serve at default priority
  // once ready — but its `taskpolicy -B -p <pid>` promote changes nothing
  // (measured 2026-10-31: every promoted backend still darwinbg). Only the
  // process itself can leave darwinbg, so it does, here, and logs the state it
  // reads back. A browser-started backend and main were never demoted, and are
  // left untouched. Serve only: an `exec` child is background work and never
  // reaches this file.
  const tier = leaveDarwinBackground();
  console.log(
    `[boot] scheduling tier once ready: ${tier.kind === "unsupported" ? `unsupported (${tier.reason})` : tier.kind}`,
  );

  // ── onReady → onAllReady ────────────────────────────────────────
  // The serving host's post-ready phases, shared with the browser host
  // (`core/boot-stages.ts`'s `runPostReadyPhases`): the change-feed assertion
  // (D3), `onReady` (eager graph-driven: each plugin fires as soon as all its
  // `dependsOn` parents have resolved), then the `onAllReady` barrier.
  await runPostReadyPhases(ordered);

  // Graceful shutdown: drain workers, flush state, release DB connections.
  // Guarded against double-entry so both SIGTERM and a follow-up SIGINT can't
  // run shutdown twice while the first pass is still draining.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received; shutting down`);
    // First, while the change feed still listens and every tab is still on its
    // socket: hand this boot's freshness to the successor (the epoch handoff).
    // The tabs reconnect only when this process exits, after it.
    // It never throws: a handoff that cannot be written is reported by its
    // writer and leaves no record (the successor then loads every sub).
    await handOffEpoch();
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

  // ── onSettled ───────────────────────────────────────────────────
  // The serving host's settled phase (`core/boot-stages.ts`'s `runSettledPhase`),
  // shared with the browser host: post-serving catch-up work — every declared
  // warm-up drains here (infra/warmup's `onSettled`). LAST, after the signal
  // handlers and the orphan poll are installed, so a SIGTERM during a long drain
  // shuts the backend down instead of waiting for it.
  await runSettledPhase(ordered);
}
