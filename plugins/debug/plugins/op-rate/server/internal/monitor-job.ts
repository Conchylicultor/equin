import { z } from "zod";
import {
  getRuntimeProfile,
  SPAN_KINDS,
  type SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import type { ConfigValues } from "@plugins/config_v2/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { opRateConfig } from "../../core";
import { windowDelta, computeRollup, type LabelDelta } from "./op-time-math";

type Thresholds = ConfigValues<(typeof opRateConfig)["fields"]>;

// The window the call-rate delta is measured over. Informational only (matches
// the cron interval): the trip decision is on the raw per-op delta vs the
// per-kind threshold, so cron skew never changes correctness.
const WINDOW_MS = 5 * 60_000;

// The span kinds the runtime profiler tracks — the recorder's single SPAN_KINDS
// source, iterated here to fan the per-op deltas across every kind. Not
// hand-mirrored, so a newly added kind is monitored with zero edits here.
const KINDS = SPAN_KINDS;

// Cap on per-op reports filed per tick, so a pathological burst across many ops
// can never storm report creation. Shared by op-rate AND op-time per-op trips in
// ONE combined ranking (over-cap trips are logged, never silently dropped, per
// repo policy). Per-kind rollup reports are separate (≤ one per kind, ≤ 7 total)
// and not subject to this cap.
const TOP_N = 20;

// Per-process baseline of each op's cumulative `count` at the previous tick,
// keyed `${kind}:${label}`. The runtime profiler accumulates `count` cumulatively
// since boot; we diff successive snapshots here so the recorder stays pure (no
// back-edge to a monitor). Lives at module scope: the job and the recorder run in
// the SAME worktree process.
const lastCount = new Map<string, number>();

// The aggregate-time twin of `lastCount`: each op's cumulative `totalMs` at the
// previous tick, same `${kind}:${label}` key, same reset-safe delta + seed
// semantics (see op-time-math.windowDelta). Diffed to catch count×cost breaches
// that per-call latency and call count alone miss.
const lastTotalMs = new Map<string, number>();

// Drop-count log for over-cap ops (one line per tick when the cap trips).
const opRateLog = Log.channel("op-rate");

// One per-op trip queued for reporting this tick. Discriminated by `type`:
// op-rate ranks on its call delta, op-time on its ms delta — different units,
// but both land in ONE combined ranking whose only job is to bound report creation
// (the `delta` sort key decides which trips to drop under the shared cap, not any
// cross-op-comparable severity).
type PerOpTrip =
  | {
      type: "op-rate";
      kind: SpanKind;
      label: string;
      delta: number; // calls in window
      threshold: number;
    }
  | {
      type: "op-time";
      kind: SpanKind;
      label: string;
      delta: number; // ms in window (the rank key)
      callsDelta: number;
      budgetMs: number;
    };

// Cheap scheduled call-rate + aggregate-time monitor. Runs every 5 min in EACH
// worktree's own process (perWorktree) because the runtime profiler is
// per-process in-memory state, so counts/totals accumulate per-backend and must
// be sampled per-backend. `dedup: "singleton"` means the monitor itself can never
// pile up, and `maxAttempts: 3` keeps a transiently-broken monitor from becoming
// a dead-job storm of its own. Reads the profile through getRuntimeProfile()
// (pull-only, no recorder hook) and diffs the cumulative `count` (op-rate) and
// `totalMs` (op-time) against the previous tick. Reports fire only when a
// per-kind threshold/budget trips (silent when healthy).
export const opRateMonitorJob = defineJob({
  name: "debug.op-rate-monitor",
  description:
    "Files a report when an operation runs far more often, or spends far more total time, than its budget allows.",
  // seconds, and NOT instant despite touching only memory and the DB: the tick
  // fans out over every profiler label across every span kind and then files up
  // to TOP_N reports, each a DB round-trip and (for op-time) a coherent-instant
  // captureTrace. Measured at ~34s per run with ZERO gate wait — 34s of real
  // work, so instant's 10s ceiling would be a lie the watchdog reports every tick.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/5 * * * *", perWorktree: true },
  maxAttempts: 3,
  run: async () => {
    const cfg = getConfig(opRateConfig);
    if (!cfg.enabled) return;

    const { aggregates } = getRuntimeProfile();
    const perOp: PerOpTrip[] = [];
    // Per-kind rollup accumulator: every op's ms delta this window (so a kind
    // whose cost is smeared across many under-budget labels still trips), plus
    // the summed call delta so the rollup report carries an honest calls count.
    const rollups: {
      kind: SpanKind;
      budgetMs: number;
      deltas: LabelDelta[];
      callsSum: number;
    }[] = [];

    for (const kind of KINDS) {
      const threshold = kindThreshold(kind, cfg);
      const budgetMs = kindMsBudget(kind, cfg);
      const kindDeltas: LabelDelta[] = [];
      let callsSum = 0;
      for (const agg of aggregates[kind]) {
        const key = `${kind}:${agg.label}`;

        // --- op-rate: cumulative call-count delta ---
        const prevCount = lastCount.get(key);
        lastCount.set(key, agg.count);
        const countDelta = windowDelta(prevCount, agg.count);
        if (countDelta !== null && countDelta > threshold)
          perOp.push({
            type: "op-rate",
            kind,
            label: agg.label,
            delta: countDelta,
            threshold,
          });

        // --- op-time: cumulative wall-clock (totalMs) delta ---
        const prevTotal = lastTotalMs.get(key);
        lastTotalMs.set(key, agg.totalMs);
        const msDelta = windowDelta(prevTotal, agg.totalMs);
        if (msDelta === null) continue; // first observation seeds, fires nothing
        kindDeltas.push({ label: agg.label, deltaMs: msDelta });
        callsSum += countDelta ?? 0;
        if (msDelta > budgetMs)
          perOp.push({
            type: "op-time",
            kind,
            label: agg.label,
            delta: msDelta,
            callsDelta: countDelta ?? 0,
            budgetMs,
          });
      }
      rollups.push({ kind, budgetMs, deltas: kindDeltas, callsSum });
    }

    // Cap the COMBINED per-op ranking (op-rate + op-time) at top-N per tick,
    // ranked by delta desc, to bound report creation. Log (don't silently drop)
    // when more than N trip.
    perOp.sort((a, b) => b.delta - a.delta);
    const top = perOp.slice(0, TOP_N);
    if (perOp.length > top.length) {
      opRateLog.publish(
        `${perOp.length - top.length} over-threshold ops not reported (top-${TOP_N} cap)`,
      );
    }

    for (const h of top) {
      if (h.type === "op-rate") {
        await recordReport({
          kind: "op-rate",
          source: "server-op-rate-monitor",
          data: {
            kind: h.kind,
            label: h.label,
            callsInWindow: h.delta,
            windowMs: WINDOW_MS,
            threshold: h.threshold,
          },
          message: `${h.kind} ${h.label} — ${h.delta} calls/window (threshold ${h.threshold})`,
        });
      } else {
        // Evidence FIRST: captureTrace grabs the coherent-instant flight window
        // (what is in flight right now while this op burns time), proving the
        // generic trigger API from a second call site. Normal engine admission
        // (cooldown + global cap + enabled) applies; returns the minted id for
        // linkage or null when rate-limited / disabled — never throws.
        // `h.delta` is AGGREGATE time burned in the window (count×cost, summed
        // across concurrent calls — routinely ≫ wall-clock), not an event
        // duration. The engine widens the persisted trace window by durationMs,
        // so passing the raw delta produced multi-hour "traces" that poisoned
        // every wall-clock view. The honest lookback is the measurement window
        // itself: the burn happened within the last WINDOW_MS.
        const trace = captureTrace({
          kind: "op-time",
          label: h.label,
          durationMs: Math.min(h.delta, WINDOW_MS),
          thresholdMs: h.budgetMs,
        });
        await recordReport({
          kind: "op-time",
          source: "server-op-rate-monitor",
          data: {
            kind: h.kind,
            label: h.label,
            msInWindow: h.delta,
            callsInWindow: h.callsDelta,
            windowMs: WINDOW_MS,
            budgetMs: h.budgetMs,
            ...(trace ? { traceId: trace.id } : {}),
          },
          message: `${h.kind} ${h.label} — ${(h.delta / 1000).toFixed(1)}s/window across ${h.callsDelta} calls (budget ${(h.budgetMs / 1000).toFixed(1)}s)`,
        });
      }
    }

    // Per-kind rollup: one report per kind whose summed per-op ms deltas exceed
    // its budget × rollupFactor. Not capped (≤ 7 kinds) and no trace (no single
    // op to point at). Carries the top-10 contributing labels.
    for (const r of rollups) {
      const breach = computeRollup(r.deltas, r.budgetMs, cfg.rollupFactor);
      if (!breach) continue;
      await recordReport({
        kind: "op-time",
        source: "server-op-rate-monitor",
        data: {
          kind: r.kind,
          msInWindow: breach.sumDeltaMs,
          callsInWindow: r.callsSum,
          windowMs: WINDOW_MS,
          budgetMs: breach.rollupBudgetMs,
          topLabels: breach.topLabels,
        },
        message: `${r.kind} rollup — ${(breach.sumDeltaMs / 1000).toFixed(1)}s/window across ${r.deltas.length} labels (budget ${(breach.rollupBudgetMs / 1000).toFixed(1)}s)`,
      });
    }
  },
});

// Map each SpanKind to its per-kind call-rate threshold field (same shape as
// slow-ops' thresholdFor). Typed over the exported SpanKind so adding a kind is a
// tsc error here until its threshold is wired.
function kindThreshold(kind: SpanKind, cfg: Thresholds): number {
  switch (kind) {
    case "http":
      return cfg.httpPerWindow;
    case "loader":
      return cfg.loaderPerWindow;
    case "sub":
      return cfg.subPerWindow;
    case "push":
      return cfg.pushPerWindow;
    case "flush":
      return cfg.flushPerWindow;
    case "db":
      return cfg.dbPerWindow;
    case "job":
      return cfg.jobPerWindow;
    // `cascade` (a dependsOn edge's ids-translation reads inside the flush) is
    // loader-class background DB work, so it shares the loader rate bar rather
    // than getting its own knob.
    case "cascade":
    // `bg` (a runTracked root — detached background work) shares the loader rate
    // bar for the same reason: background-class, no separate knob.
    case "bg":
    // `route` (change-feed routing) and `membership` (a window's ids query) are
    // live-state plumbing around the loader — same bar, no separate knob.
    case "route":
    case "membership":
      return cfg.loaderPerWindow;
  }
}

// Map each SpanKind to its per-kind aggregate-time (ms) budget field — the
// op-time twin of kindThreshold. Typed over SpanKind so adding a kind is a tsc
// error here until its budget is wired.
function kindMsBudget(kind: SpanKind, cfg: Thresholds): number {
  switch (kind) {
    case "http":
      return cfg.httpMsPerWindow;
    case "loader":
      return cfg.loaderMsPerWindow;
    case "sub":
      return cfg.subMsPerWindow;
    case "push":
      return cfg.pushMsPerWindow;
    case "flush":
      return cfg.flushMsPerWindow;
    case "db":
      return cfg.dbMsPerWindow;
    case "job":
      return cfg.jobMsPerWindow;
    // `cascade` shares the loader budget for the same reason it shares the
    // loader rate bar in kindThreshold above: loader-class background DB work.
    case "cascade":
    // `bg` (detached background work) shares the loader budget too — see
    // kindThreshold above.
    case "bg":
    // `route` / `membership`: see kindThreshold above.
    case "route":
    case "membership":
      return cfg.loaderMsPerWindow;
  }
}
