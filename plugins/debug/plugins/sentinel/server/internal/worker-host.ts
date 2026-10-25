import { namespaceArgv } from "@plugins/infra/plugins/runtime-identity/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_BACKOFF,
  defineDaemon,
  type DaemonDecl,
  type DaemonTransition,
  type WorkerDaemonInstance,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import type { SentinelStatus } from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import type {
  MainToWorkerFrame,
  WorkerInitFrame,
  WorkerThresholdsFrame,
  WorkerToMainFrame,
} from "./worker/protocol";

// Main-side host for the sentinel worker: starts the Bun Worker through the
// daemon primitive (which supervises it — respawn with backoff, give-up after
// repeated rapid deaths — and lists it in Background activity), pushes live
// settings, relays its frames to the re-emitters (sampler.ts / onset.ts), and
// maps the supervision transitions onto the sentinel's status. Main is
// deliberately NOT on the latch's critical path — the worker owns sampler +
// detector + latch lifecycle entirely (Stage 5,
// research/2026-07-11-global-observability-freeze-blind-spots.md).
//
// Config-free on purpose: the caller reads config and pushes it in, so this
// module can be driven by a test with a worker of its choosing.

/**
 * The sentinel worker, declared once. A death within 2 s of spawn means it
 * never got going (e.g. its module graph throws at load); after
 * MAX_RAPID_FAILURES such deaths in a row the primitive gives up — status
 * `down`, which the caller turns into a report and the health row — instead of
 * respawn-looping forever. Healthy once the worker sends its `ready` frame.
 */
export const sentinelWorkerDaemon = defineDaemon({
  name: "sentinel.worker",
  description:
    "The cluster congestion sentinel: a worker thread that samples host load, Postgres pressure and every backend's health every few seconds, detects congestion onset, and holds the host-wide duress latch even while the main event loop is wedged.",
  startedBy: "boot",
  where: "host-singleton",
  restart: { kind: "backoff", healthy: "ready" },
});

export const MAX_RAPID_FAILURES = DEFAULT_BACKOFF.maxRapidFailures;
/** How long stop() waits for the worker's `stopped` ack before terminating. */
const STOP_ACK_TIMEOUT_MS = 2_000;

export interface WorkerFrameHandlers {
  onSample: (frame: Extract<WorkerToMainFrame, { type: "sample" }>) => void;
  onTrip: (frame: Extract<WorkerToMainFrame, { type: "trip" }>) => void;
  onClear: (frame: Extract<WorkerToMainFrame, { type: "clear" }>) => void;
  onLog: (line: string, stream?: "stdout" | "stderr") => void;
  /** Every supervision transition, in order, starting with `starting`. */
  onStatus: (status: SentinelStatus) => void;
}

/** What the worker is configured with; `cadenceMs` applies at spawn only. */
export type SentinelWorkerSettings = Omit<WorkerInitFrame, "type">;

export interface SentinelWorkerOptions {
  handlers: WorkerFrameHandlers;
  settings: SentinelWorkerSettings;
  /**
   * Which module to run, and with what environment. Defaults to the real
   * worker ({@link resolveWorkerUrl}) under this process's environment; a test
   * points it at a throwaway module or a temp data root.
   */
  worker?: { url: URL; env?: Record<string, string> };
  /** Respawn backoff bounds. Defaults to 1 s → 30 s; a test shortens them. */
  backoff?: { minMs: number; maxMs: number };
  /**
   * The declaration to start it under. Defaults to {@link sentinelWorkerDaemon}
   * (host-singleton); a test, which runs as a worktree, brings one declared
   * for every worktree.
   */
  daemon?: Pick<DaemonDecl, "spawnWorker">;
}

interface HostState {
  handlers: WorkerFrameHandlers;
  settings: SentinelWorkerSettings;
  instance: WorkerDaemonInstance | null;
  stoppedAck: (() => void) | null;
}

let state: HostState | null = null;

function dispatch(
  s: HostState,
  frame: WorkerToMainFrame,
  ready: () => void,
): void {
  switch (frame.type) {
    case "sample":
      s.handlers.onSample(frame);
      break;
    case "trip":
      s.handlers.onTrip(frame);
      break;
    case "clear":
      s.handlers.onClear(frame);
      break;
    case "log":
      s.handlers.onLog(frame.line, frame.stream);
      break;
    case "ready":
      // Healthy spawn: the primitive resets its give-up counters and reports
      // `running`.
      ready();
      break;
    case "stopped":
      s.stoppedAck?.();
      break;
  }
}

/** The primitive's transitions, as the sentinel's status file spells them. */
function toStatus(t: DaemonTransition): SentinelStatus {
  switch (t.state) {
    case "starting":
      return { state: "starting", since: t.at };
    case "running":
      return { state: "running", since: t.at };
    case "respawning":
      return {
        state: "respawning",
        since: t.at,
        deaths: t.deaths,
        lastError: t.lastError,
      };
    case "gave-up":
    case "exited":
      return {
        state: "down",
        since: t.at,
        deaths: t.state === "gave-up" ? t.deaths : 1,
        lastError: t.lastError,
      };
    case "stopped":
      return { state: "stopped", since: t.at };
  }
}

/**
 * Resolve the worker module URL.
 *
 * Dev (backend runs from source): the `new URL("./worker/entry.ts",
 * import.meta.url)` form resolves against this file's on-disk location.
 *
 * Compiled release: `bun build --compile` does NOT trace/embed a
 * `new Worker(new URL(...))` entry (verified Bun 1.3.13), so release.ts vendors
 * the worker as a standalone bundled `.js` on disk and launch.ts points
 * `EQUIN_SENTINEL_WORKER_JS` at it — the same vendored-asset pattern as
 * `EQUIN_PARCEL_WATCHER_NODE`. When set, spawn from that file.
 */
function resolveWorkerUrl(): URL {
  const vendored = readEnv("SENTINEL_WORKER_JS");
  return vendored
    ? pathToFileURL(vendored)
    : new URL("./worker/entry.ts", import.meta.url);
}

export function startSentinelWorker(opts: SentinelWorkerOptions): void {
  if (state) return;
  const s: HostState = {
    handlers: opts.handlers,
    settings: opts.settings,
    instance: null,
    stoppedAck: null,
  };
  state = s;
  s.instance = (opts.daemon ?? sentinelWorkerDaemon).spawnWorker({
    url: opts.worker?.url ?? resolveWorkerUrl(),
    // The worker declares its namespace from argv as its first import, before
    // any module that resolves a path from it (worker/declare-namespace.ts).
    argv: namespaceArgv(),
    ...(opts.worker?.env ? { env: opts.worker.env } : {}),
    ...(opts.backoff ? { backoff: opts.backoff } : {}),
    // Each spawn (respawns included) inits with the latest settings. A
    // respawned worker adopts a fresh existing latch at init (reads it, seeds
    // tripped, keeps refreshing), so a mid-episode crash misses refreshes for
    // ≪ the 60s lease.
    onSpawn: (worker) => {
      const init: WorkerInitFrame = { type: "init", ...s.settings };
      worker.postMessage(init);
    },
    onMessage: (data, ctx) => {
      dispatch(s, data as WorkerToMainFrame, ctx.ready);
    },
    onError: (message) => {
      s.handlers.onLog(`sentinel worker error: ${message}`, "stderr");
    },
    // Graceful stop: the worker clears the latch if tripped (writing the clear
    // episode line) and acks; the primitive terminates it either way.
    stop: async (worker) => {
      let ackTimer: ReturnType<typeof setTimeout> | null = null;
      const acked = new Promise<void>((resolve) => {
        s.stoppedAck = resolve;
        ackTimer = setTimeout(resolve, STOP_ACK_TIMEOUT_MS);
      });
      worker.postMessage({ type: "stop" } satisfies MainToWorkerFrame);
      await acked;
      if (ackTimer) clearTimeout(ackTimer);
    },
    onState: (t) => s.handlers.onStatus(toStatus(t)),
    onLog: (line) => s.handlers.onLog(line, "stderr"),
  });
}

/**
 * Push live threshold values. The worker cannot getConfig (no plugin runtime),
 * so main watches config and pushes; a wedged main only stales the thresholds —
 * the worker retains the last pushed values. A respawn inits with the latest.
 */
export function pushSentinelThresholds(
  frame: Omit<WorkerThresholdsFrame, "type">,
): void {
  const s = state;
  if (!s) return;
  s.settings = { ...s.settings, ...frame };
  s.instance?.postMessage({
    type: "config",
    ...frame,
  } satisfies MainToWorkerFrame);
}

export async function stopSentinelWorker(): Promise<void> {
  const s = state;
  if (!s) return;
  state = null;
  // Records `stopped` through onState.
  await s.instance?.stop();
}
