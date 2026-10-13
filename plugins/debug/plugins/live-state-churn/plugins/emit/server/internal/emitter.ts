import { triggerResourcePush } from "@plugins/framework/plugins/server-core/core";
import { DEFAULT_EMIT_DURATION_MS, MAX_EMIT_DURATION_MS } from "../../core";
import type { EmitStatus } from "../../shared/endpoints";

// Singleton in-memory controller for one synthetic no-op push session.
//
// Why a setInterval and NOT a defineJob / graphile cron task: the no-polling rule
// forbids `setInterval` loops that *poll for change*. This is the opposite — a
// deliberate, on-demand **signal GENERATOR** that fires synthetic no-op pushes at
// a sub-second cadence (N/sec is below graphile cron's 5-field 1-minute floor, so
// the queue could never drive it). It is started/stopped explicitly by a debugger
// and bounded by a hard auto-stop cap, so a forgotten session can't churn
// forever. It generates pushes; it does not watch for them. Mirrors the
// setInterval exception in health-monitor's process-sampler.

interface EmitState {
  active: boolean;
  key: string | null;
  rate: number;
  timer: ReturnType<typeof setInterval> | null;
  autoStopTimer: ReturnType<typeof setTimeout> | null;
  startedAtMs: number | null;
  endsAtMs: number | null;
  ticks: number;
  lastSubscriberCount: number;
}

const state: EmitState = {
  active: false,
  key: null,
  rate: 0,
  timer: null,
  autoStopTimer: null,
  startedAtMs: null,
  endsAtMs: null,
  ticks: 0,
  lastSubscriberCount: 0,
};

// Status observers: every change to `state` that `getStatus()` reports (start,
// stop, auto-stop, each tick) calls them — the live `live-state-emit.status`
// value's change source. Called on the emitter's own timer: cheap, never throws.
type StatusObserver = () => void;
const statusObservers = new Set<StatusObserver>();
export function onEmitStatusChange(cb: StatusObserver): () => void {
  statusObservers.add(cb);
  return () => {
    statusObservers.delete(cb);
  };
}
function statusChanged(): void {
  for (const cb of statusObservers) cb();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Start (or restart) a single active emit session. */
export function startEmitting(
  key: string,
  rate: number,
  durationMs?: number,
): EmitStatus {
  // Single active session — tear down any existing one first.
  stopEmitting();

  // Cap the delivered cadence at 100/s even if a higher rate slips through.
  const intervalMs = Math.max(1000 / rate, 10);
  const lifetimeMs = clamp(
    durationMs ?? DEFAULT_EMIT_DURATION_MS,
    1,
    MAX_EMIT_DURATION_MS,
  );
  const now = Date.now();

  state.active = true;
  state.key = key;
  state.rate = rate;
  state.startedAtMs = now;
  state.endsAtMs = now + lifetimeMs;
  state.ticks = 0;
  state.lastSubscriberCount = 0;

  // A raw interval, allowlisted in detached-work-safety's `no-raw-set-interval`
  // ignores: a synthetic churn test harness deliberately driving N no-op
  // pushes/sec at a runtime-chosen rate; spanning it would attribute synthetic
  // test load.
  state.timer = setInterval(() => {
    // triggerResourcePush re-emits the resource to its current subscribers with
    // no DB change → an empty-diff no-op push (the exact real-churn code path).
    state.lastSubscriberCount = triggerResourcePush(key);
    state.ticks++;
    statusChanged();
  }, intervalMs);

  state.autoStopTimer = setTimeout(stopEmitting, lifetimeMs);

  statusChanged();
  return getStatus();
}

/** Stop the active session (idempotent). Clears both timers. */
export function stopEmitting(): EmitStatus {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.autoStopTimer) {
    clearTimeout(state.autoStopTimer);
    state.autoStopTimer = null;
  }
  state.active = false;
  statusChanged();
  return getStatus();
}

/** Snapshot of the current controller state. */
export function getStatus(): EmitStatus {
  return {
    active: state.active,
    key: state.key,
    rate: state.rate,
    startedAtMs: state.startedAtMs,
    endsAtMs: state.endsAtMs,
    ticks: state.ticks,
    lastSubscriberCount: state.lastSubscriberCount,
  };
}
