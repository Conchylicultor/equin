import { z } from "zod";
import {
  getRuntimeProfile,
  profilerNowMs,
  SPAN_KINDS,
  type GateHolder,
  type SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import type { ConfigValues } from "@plugins/config_v2/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { opRateConfig, type OpRateRegime, type OpRateSpan } from "../../core";
import {
  windowDelta,
  computeRollup,
  gateTrips,
  type GateBaseline,
  type LabelDelta,
} from "./op-time-math";
import {
  BASELINE_QUANTILE,
  callsPerWindow,
  HOUR_QUANTILE,
  hourThresholdOf,
  MIN_COVERED_HOURS,
  MIN_HISTORY_WINDOWS,
  planTick,
  thresholdOf,
  usualCallsOf,
  usualHourCallsOf,
  utcHourStart,
  WINDOW_MS,
  type OpRateBasis,
  type TickState,
} from "./op-rate-baseline";
import { readHistory, readHourHistory, recordWindow } from "./baseline-store";

type Thresholds = ConfigValues<(typeof opRateConfig)["fields"]>;

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
// since its epoch (process start or a reset); we diff successive snapshots here
// so the recorder stays pure (no back-edge to a monitor). Lives at module scope:
// the job and the recorder run in the SAME worktree process. Which window a
// tick's counts close — and whether they all started at 0 — is `planTick`'s,
// from the profile's epoch and this process's previous tick (`lastTick`).
const lastCount = new Map<string, number>();
let lastTick: TickState | undefined;

// The aggregate-time twin of `lastCount`: each op's cumulative OWN time
// (`selfTotalMs`) at the previous tick, same `${kind}:${label}` key, same
// reset-safe delta + seed semantics (see op-time-math.windowDelta). Own time,
// never wall: an op is judged on the work it did. A `sub` queued 85 s on
// `read-admit`, a delivery held 500 ms by its own declared throttle, a loader
// awaiting a memo's in-flight pass — none of that is the op's cost, so none of
// it trips the op. Its wall (`lastWallMs`) rides the report as context.
const lastSelfMs = new Map<string, number>();
const lastWallMs = new Map<string, number>();

// The waits an op is judged without are not dropped: each gate's metered
// queue/io waits (`getRuntimeProfile().gates`, charged once per wait where it
// happens) are diffed here by layer and judged against `waitMsPerWindow` — the
// gate's congestion over the window, against the gate (with its holders),
// instead of as N innocent waiters. (slow-ops' `wait <layer>` is the other
// view: one op's wait past its bar, or a stretch where the leftover waits of
// independent ops kept the gate's queue held past the same bar.)
const lastGates: GateBaseline = new Map();

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
      delta: number; // calls in window (per standard window)
      windowMs: number;
      threshold: number;
      /** Absent when judged on the per-kind warm-up threshold. */
      baseline?: { over: OpRateSpan; usualCalls: number };
    }
  | {
      type: "op-time";
      kind: SpanKind;
      label: string;
      delta: number; // own ms in window (the rank key)
      wallDelta: number;
      callsDelta: number;
      budgetMs: number;
    }
  | {
      type: "gate-wait";
      layer: string;
      delta: number; // ms waited on the gate in window (the rank key)
      waitsDelta: number;
      budgetMs: number;
      holders: readonly GateHolder[];
    };

// Cheap scheduled call-rate + aggregate-time monitor. Runs every 5 min in EACH
// worktree's own process (perWorktree) because the runtime profiler is
// per-process in-memory state, so counts/totals accumulate per-backend and must
// be sampled per-backend. `dedup: "singleton"` means the monitor itself can never
// pile up, and `maxAttempts: 3` keeps a transiently-broken monitor from becoming
// a dead-job storm of its own. Reads the profile through getRuntimeProfile()
// (pull-only, no recorder hook) and diffs the cumulative `count` (op-rate) and
// own time `selfTotalMs` (op-time) and each gate's metered waits against the
// previous tick. Reports fire only when a
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

    const { aggregates, gates, sinceMs } = getRuntimeProfile();
    const nowMs = profilerNowMs();
    const wallNow = Date.now();
    // The process's start on the profiler clock (performance.now()'s origin).
    const processStartMs = nowMs - performance.now();
    const plan = planTick(lastTick, sinceMs, nowMs, processStartMs);
    if (plan.kind === "unjudgeable")
      opRateLog.publish(`call counts not judged this tick: ${plan.reason}`);
    // This tick's readings become the module state only once the whole tick
    // has succeeded (see `commit` at the end): a tick that throws, and is
    // retried, re-diffs the same window instead of losing it, and records it
    // in the history once.
    const prevCounts =
      plan.kind === "window" && !plan.fromZero
        ? lastCount
        : new Map<string, number>();
    const nextCount = new Map<string, number>();
    const nextSelfMs = new Map<string, number>();
    const nextWallMs = new Map<string, number>();
    const nextGates: GateBaseline = new Map(lastGates);
    // This window's calls per op (per standard window), for the history and
    // the judgement below.
    const windowCalls = new Map<
      string,
      { kind: SpanKind; label: string; calls: number }
    >();
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
      const budgetMs = kindMsBudget(kind, cfg);
      const kindDeltas: LabelDelta[] = [];
      let callsSum = 0;
      for (const agg of aggregates[kind]) {
        const key = `${kind}:${agg.label}`;

        // --- op-rate: this window's calls (judged after the loop) ---
        const prevCount = prevCounts.get(key) ?? 0;
        nextCount.set(key, agg.count);
        let countDelta: number | null = null;
        if (plan.kind === "window") {
          countDelta = agg.count - prevCount;
          if (countDelta < 0)
            throw new Error(
              `op-rate: ${key} count went from ${prevCount} to ${agg.count} within one profile epoch`,
            );
          const calls = callsPerWindow(countDelta, plan.windowMs);
          if (calls > 0)
            windowCalls.set(key, { kind, label: agg.label, calls });
        }

        // --- op-time: cumulative OWN-time (selfTotalMs) delta ---
        const prevSelf = lastSelfMs.get(key);
        nextSelfMs.set(key, agg.selfTotalMs);
        const prevWall = lastWallMs.get(key);
        nextWallMs.set(key, agg.totalMs);
        const msDelta = windowDelta(prevSelf, agg.selfTotalMs);
        if (msDelta === null) continue; // first observation seeds, fires nothing
        kindDeltas.push({ label: agg.label, deltaMs: msDelta });
        callsSum += countDelta ?? 0;
        if (msDelta > budgetMs)
          perOp.push({
            type: "op-time",
            kind,
            label: agg.label,
            delta: msDelta,
            wallDelta: windowDelta(prevWall, agg.totalMs) ?? msDelta,
            callsDelta: countDelta ?? 0,
            budgetMs,
          });
      }
      rollups.push({ kind, budgetMs, deltas: kindDeltas, callsSum });
    }

    // --- op-rate: each op's window, and its hour so far, against its own
    // history (one report per op: the trip furthest past its bar). Read-only
    // here; the window joins the history after the reports are filed. ---
    // The window's middle: a window closed on the hour belongs to the hour it
    // covered.
    const atMs = plan.kind === "window" ? wallNow - plan.windowMs / 2 : 0;
    if (plan.kind === "window")
      perOp.push(
        ...worstPerOp([
          ...(await judgeCallRates(
            plan.regime,
            plan.windowMs,
            windowCalls,
            atMs,
            cfg,
          )),
          ...(await judgeHourRates(atMs, windowCalls, cfg)),
        ]),
      );

    // --- gate waits: each gate's metered wait time, judged as the gate's ---
    const holdersOf = new Map(gates.map((g) => [g.layer, g.holders ?? []]));
    for (const t of gateTrips(gates, nextGates, cfg.waitMsPerWindow))
      perOp.push({
        type: "gate-wait",
        layer: t.layer,
        delta: t.msDelta,
        waitsDelta: t.waitsDelta,
        budgetMs: cfg.waitMsPerWindow,
        holders: holdersOf.get(t.layer) ?? [],
      });

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
            windowMs: h.windowMs,
            threshold: h.threshold,
            ...(h.baseline && { baseline: h.baseline }),
          },
          message: h.baseline
            ? h.baseline.over === "hour"
              ? `${h.kind} ${h.label} — ${h.delta} calls so far this hour, usually ≤${h.baseline.usualCalls} in an hour (threshold ${h.threshold})`
              : `${h.kind} ${h.label} — ${h.delta} calls/window, usually ≤${h.baseline.usualCalls} in a ${h.baseline.over} window (threshold ${h.threshold})`
            : `${h.kind} ${h.label} — ${h.delta} calls/window (warm-up threshold ${h.threshold})`,
        });
      } else if (h.type === "gate-wait") {
        // The gate's congestion, filed against the gate: who held it right now
        // (its gauge's holders) and the flight window as evidence. Its waiters
        // were judged without this time — this is where it is reported.
        const holders = h.holders;
        const trace = captureTrace({
          kind: "op-time",
          label: `wait ${h.layer}`,
          durationMs: Math.min(h.delta, WINDOW_MS),
          thresholdMs: h.budgetMs,
        });
        await recordReport({
          kind: "op-time",
          source: "server-op-rate-monitor",
          data: {
            kind: WAIT_KIND,
            label: h.layer,
            msInWindow: h.delta,
            callsInWindow: h.waitsDelta,
            windowMs: WINDOW_MS,
            budgetMs: h.budgetMs,
            ...(holders.length > 0 && {
              holders: holders.slice(0, 10).map((x) => x.label),
            }),
            ...(trace ? { traceId: trace.id } : {}),
          },
          message: `wait ${h.layer} — ${(h.delta / 1000).toFixed(1)}s/window waited across ${h.waitsDelta} waits (budget ${(h.budgetMs / 1000).toFixed(1)}s)`,
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
            wallMsInWindow: h.wallDelta,
            callsInWindow: h.callsDelta,
            windowMs: WINDOW_MS,
            budgetMs: h.budgetMs,
            ...(trace ? { traceId: trace.id } : {}),
          },
          message: `${h.kind} ${h.label} — ${(h.delta / 1000).toFixed(1)}s own/window (${(h.wallDelta / 1000).toFixed(1)}s wall) across ${h.callsDelta} calls (budget ${(h.budgetMs / 1000).toFixed(1)}s)`,
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
        message: `${r.kind} rollup — ${(breach.sumDeltaMs / 1000).toFixed(1)}s own/window across ${r.deltas.length} labels (budget ${(breach.rollupBudgetMs / 1000).toFixed(1)}s)`,
      });
    }

    // The window joins the call history, then the tick's readings become the
    // state the next tick diffs against.
    if (plan.kind === "window")
      await recordWindow(
        plan.regime,
        atMs,
        new Map([...windowCalls].map(([key, w]) => [key, w.calls])),
      );
    lastTick = { epoch: sinceMs, atMs: nowMs };
    replaceMap(lastCount, nextCount);
    replaceMap(lastSelfMs, nextSelfMs);
    replaceMap(lastWallMs, nextWallMs);
    replaceMap(lastGates, nextGates);
  },
});

function replaceMap<K, V>(target: Map<K, V>, next: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [k, v] of next) target.set(k, v);
}

// Judge each op's calls in this window against the op's own history of that
// regime (op-rate-baseline.ts). Only ops past the lowest bar that could fire are
// looked up. A regime with under MIN_HISTORY_WINDOWS of history is warming up:
// a steady window is judged on the per-kind warm-up threshold, a boot window is
// not judged (logged) — exactly what op-rate did before it had a history. An op
// the history has never seen called is warming up too.
async function judgeCallRates(
  regime: OpRateRegime,
  windowMs: number,
  windowCalls: ReadonlyMap<
    string,
    { kind: SpanKind; label: string; calls: number }
  >,
  atMs: number,
  cfg: Thresholds,
): Promise<PerOpTrip[]> {
  const rule = { minCalls: cfg.minCallsPerWindow, factor: cfg.baselineFactor };
  const candidates = [...windowCalls].filter(
    ([, w]) => w.calls > Math.min(rule.minCalls, kindThreshold(w.kind, cfg)),
  );
  if (candidates.length === 0) return [];
  const history = await readHistory(
    regime,
    atMs,
    candidates.map(([key]) => key),
  );
  const learned = history.windows >= MIN_HISTORY_WINDOWS[regime];
  if (!learned && regime === "boot") {
    opRateLog.publish(
      `boot window not judged: ${history.windows} past boot windows (needs ${MIN_HISTORY_WINDOWS.boot})`,
    );
    return [];
  }
  const trips: PerOpTrip[] = [];
  for (const [key, w] of candidates) {
    const opHistory = history.ops.get(key);
    if (opHistory === undefined)
      throw new Error(`op-rate: no history read for ${key}`);
    // An op with no called window in the history is new to it (a changed SQL
    // text is a new `db` label; a new resource is a new key): it has no usual
    // rate yet, so it is judged on the warm-up bar, never as a jump from 0.
    const basis: OpRateBasis =
      learned && opHistory.buckets.size > 0
        ? {
            kind: "baseline",
            usualCalls: usualCallsOf(opHistory, BASELINE_QUANTILE[regime]),
          }
        : { kind: "warm-up", threshold: kindThreshold(w.kind, cfg) };
    const threshold = thresholdOf(basis, rule);
    if (w.calls <= threshold) continue;
    trips.push({
      type: "op-rate",
      kind: w.kind,
      label: w.label,
      delta: w.calls,
      windowMs: Math.round(Math.min(windowMs, WINDOW_MS)),
      threshold,
      ...(basis.kind === "baseline" && {
        baseline: { over: regime, usualCalls: basis.usualCalls },
      }),
    });
  }
  return trips;
}

// Judge each op called in this window on its calls so far in the clock hour
// (the history's hour plus this window) against its usual hour
// (op-rate-baseline.ts, *The hour horizon*). Only an op called in this window
// is judged, so an hour trip stops once its op does. Under MIN_COVERED_HOURS of
// history the hour is not judged (the window's warm-up bar covers that day),
// nor is an op with no past hour (new to the history, judged on its window).
async function judgeHourRates(
  atMs: number,
  windowCalls: ReadonlyMap<
    string,
    { kind: SpanKind; label: string; calls: number }
  >,
  cfg: Thresholds,
): Promise<PerOpTrip[]> {
  if (windowCalls.size === 0) return [];
  const rule = { minCalls: cfg.minCallsPerWindow, factor: cfg.baselineFactor };
  const history = await readHourHistory(
    atMs,
    new Map([...windowCalls].map(([key, w]) => [key, w.calls])),
    hourThresholdOf(0, rule),
  );
  if (history.coveredHours < MIN_COVERED_HOURS) return [];
  const trips: PerOpTrip[] = [];
  for (const [key, h] of history.ops) {
    const w = windowCalls.get(key);
    if (w === undefined)
      throw new Error(`op-rate: hour history answered an op not asked: ${key}`);
    if (!h.pastHours.some((n) => n > 0)) continue;
    const usualCalls = usualHourCallsOf(h.pastHours, HOUR_QUANTILE);
    const threshold = hourThresholdOf(usualCalls, rule);
    if (h.hourSoFar <= threshold) continue;
    trips.push({
      type: "op-rate",
      kind: w.kind,
      label: w.label,
      delta: h.hourSoFar,
      windowMs: Math.round(atMs - utcHourStart(atMs).getTime()),
      threshold,
      baseline: { over: "hour", usualCalls },
    });
  }
  return trips;
}

// One op-rate trip per op: the one furthest past its own bar.
function worstPerOp(trips: readonly PerOpTrip[]): PerOpTrip[] {
  const worst = new Map<string, PerOpTrip & { type: "op-rate" }>();
  for (const t of trips) {
    if (t.type !== "op-rate") continue;
    const key = `${t.kind}:${t.label}`;
    const prev = worst.get(key);
    if (
      prev === undefined ||
      t.delta / t.threshold > prev.delta / prev.threshold
    )
      worst.set(key, t);
  }
  return [...worst.values()];
}

// The `kind` a gate's op-time report carries: a gate is no span kind, so its
// fingerprint (`op-time:wait:<layer>`) can never collide with an op's.
const WAIT_KIND = "wait";

// Map each SpanKind to its per-kind warm-up call-rate threshold field (same
// shape as slow-ops' thresholdFor). Typed over the exported SpanKind so adding a kind is a
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
