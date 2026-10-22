import { getConfig } from "@plugins/config_v2/server";
import { reportsConfig } from "@plugins/reports/core";

// The reports engine's cross-fingerprint fan-out ceiling — the twin of
// velocity.ts. velocity.ts is the per-fingerprint half of the throttle (one
// fingerprint firing repeatedly stops churning the bell); this is the
// cross-fingerprint half, per kind: how many DISTINCT fingerprints of one kind
// may raise their own alert inside a window. The same shape trace capture
// already has (`admitTrace`: a per-key cooldown plus one global per-minute
// bucket) — reports had only the per-key half.
//
// See research/2026-09-02-global-alert-fan-out-ceiling.md. On 2026-09-02 a 90 s
// host duress episode dropped the notifications socket; on reconnect ~420
// distinct per-row resources all re-settled slow at once and filed 422 reports
// in 24 s. Every existing guard keys on the operation identity, so all 422 were
// distinct and none engaged.
//
// Two properties make collapsing safe even for kinds whose row is the only
// evidence (crash):
//
//  - The budget is spent by a fingerprint NEWLY alerting, not by an occurrence.
//    A fingerprint that already alerted this window passes straight through —
//    its row upsert, its `count` bump and its 60 s bell cooldown are untouched.
//    Repeats are not fan-out.
//  - The budget refills every window. Collapse is temporary: anything
//    persistent mints its own row in the next window. Only the simultaneous
//    burst collapses.

/**
 * The config values the gate reads per admit. Structural on purpose:
 * getConfig(reportsConfig) satisfies it, and tests inject plain literals via
 * _setFanOutConfigForTests.
 */
export interface FanOutConfigValues {
  fanOutPerWindow: number;
  fanOutWindowMs: number;
  stormRosterMax: number;
}

/**
 * The resolved ceiling for one admit. The pure core reads no config, so the
 * budget IS how config (and a kind's own raise) reaches it. `rosterMax` rides
 * here for the same reason — it is a per-admit config read, not core state.
 */
export interface FanOutBudget {
  distinctPerWindow: number;
  windowMs: number;
  rosterMax: number;
}

/** Whether this occurrence may raise its own alert, or was folded into the kind's storm. */
export type AlertAdmission = { alert: true } | { alert: false };

/** One collapsed fingerprint, as the rollup names it. */
export interface StormRosterEntry {
  fingerprint: string;
  /** The clamped one-line message of the occurrence that first collapsed under this fingerprint. */
  message: string;
  /** Collapsed occurrences for this fingerprint (the alert it did not get). */
  count: number;
}

/**
 * One kind's collapse accounting for one storm, handed to the gate's onStorm
 * consumer, which files it as a `report-storm` report. The debug/report-storm
 * kind carries a compile-time guard that this shape parses as its payload.
 */
export interface StormSummary {
  /** The report kind whose alerts were collapsed (never the storm kind itself). */
  collapsedKind: string;
  windowStartedAt: number;
  windowEndedAt: number;
  /** The ceiling in force when the collapse started. */
  budget: number;
  distinctFingerprints: number;
  occurrences: number;
  roster: StormRosterEntry[];
  /** Distinct collapsed fingerprints the roster had no room to name. */
  rosterTruncated: number;
}

// Belt-and-braces bound on the distinct-fingerprint counter, in the spirit of
// admitTrace's MAX_TRACKED_OPS. A storm accumulator lives at most one window,
// and the incident this exists for had ~420 distinct keys; saturating at 100k
// would take a pathological key source. Past the cap `distinctFingerprints`
// saturates (it is then a floor) while `occurrences` keeps counting truthfully.
const MAX_TRACKED_FINGERPRINTS = 100_000;

// --- Pure core -------------------------------------------------------------
//
// All bookkeeping (window roll, budget spend, roster fold, caps, truncation
// accounting) lives here, deterministic over explicit inputs — no clock, no
// timer, no config — so the semantics are directly bun-testable. The
// createFanOutGate wrapper below binds it to the live config and the one-shot
// storm timer.

interface StormAccumulator {
  startedAt: number;
  budget: number;
  /** Distinct collapsed fingerprints, capped at MAX_TRACKED_FINGERPRINTS. */
  seen: Set<string>;
  /** The named subset of `seen`, capped at the budget's rosterMax. */
  roster: Map<string, { message: string; count: number }>;
  occurrences: number;
}

interface KindState {
  windowStartedAt: number;
  /** Fingerprints holding an alert this window; bounded by the budget. */
  alerted: Set<string>;
  /** Non-null once something collapsed; survives a window roll until taken. */
  storm: StormAccumulator | null;
}

export interface FanOutCore {
  admit(
    kind: string,
    fingerprint: string,
    message: string,
    now: number,
    budget: FanOutBudget,
  ): AlertAdmission;
  /** True while a kind owes a storm rollup nobody has taken yet. */
  stormOwed(kind: string): boolean;
  /** Detach and return the kind's collapse accounting, closing its storm. */
  takeStorm(kind: string, now: number): StormSummary | null;
}

export function createFanOutCore(): FanOutCore {
  const states = new Map<string, KindState>();

  function stateFor(kind: string, now: number): KindState {
    let st = states.get(kind);
    if (!st) {
      st = { windowStartedAt: now, alerted: new Set(), storm: null };
      states.set(kind, st);
    }
    return st;
  }

  return {
    admit(kind, fingerprint, message, now, budget) {
      const st = stateFor(kind, now);
      if (now - st.windowStartedAt > budget.windowMs) {
        // The roll re-grants the budget. It deliberately does NOT touch the
        // storm accumulator: the rollup is owed until takeStorm runs, so a
        // roll racing the one-shot timer can never discard the accounting.
        st.windowStartedAt = now;
        st.alerted.clear();
      }

      // Repeats are not fan-out: a fingerprint that already alerted this
      // window keeps today's behaviour exactly (row upsert, count bump, bell
      // cooldown).
      if (st.alerted.has(fingerprint)) return { alert: true };

      if (st.alerted.size < budget.distinctPerWindow) {
        st.alerted.add(fingerprint);
        return { alert: true };
      }

      const storm = (st.storm ??= {
        startedAt: st.windowStartedAt,
        budget: budget.distinctPerWindow,
        seen: new Set<string>(),
        roster: new Map(),
        occurrences: 0,
      });
      storm.occurrences += 1;
      const entry = storm.roster.get(fingerprint);
      if (entry) {
        entry.count += 1;
      } else if (storm.seen.size < MAX_TRACKED_FINGERPRINTS) {
        // The roster insert is NESTED inside the seen insert on purpose: it
        // makes `roster ⊆ seen` true by construction, whatever rosterMax is
        // configured to, so `rosterTruncated = seen - roster` can never go
        // negative. A fingerprint past the tracking cap gets neither, and only
        // bumps `occurrences` — which stays exact.
        storm.seen.add(fingerprint);
        if (storm.roster.size < budget.rosterMax) {
          storm.roster.set(fingerprint, { message, count: 1 });
        }
      }
      return { alert: false };
    },

    stormOwed(kind) {
      return states.get(kind)?.storm != null;
    },

    takeStorm(kind, now) {
      const st = states.get(kind);
      const storm = st?.storm;
      if (!st || !storm) return null;
      st.storm = null;
      const roster: StormRosterEntry[] = [...storm.roster.entries()]
        .map(([fingerprint, e]) => ({
          fingerprint,
          message: e.message,
          count: e.count,
        }))
        // Loudest first: the rollup's whole value is naming what dominated the
        // burst, and the roster is the only place that ordering exists.
        .sort((a, b) => b.count - a.count);
      return {
        collapsedKind: kind,
        windowStartedAt: storm.startedAt,
        windowEndedAt: now,
        budget: storm.budget,
        distinctFingerprints: storm.seen.size,
        occurrences: storm.occurrences,
        roster,
        rosterTruncated: storm.seen.size - roster.length,
      };
    },
  };
}

// --- Impure wrapper ---------------------------------------------------------

// One-shot storm timer, seam-able for tests. Never cancelled and never
// repeated: the first collapse for a kind arms exactly one timeout, which
// closes that kind's storm and re-opens arming. Same shape as the shed
// buffer's maybeArmFlush — never a poll.
interface StormTimer {
  set(fn: () => void, delayMs: number): void;
}

const realTimer: StormTimer = {
  set: (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
};
let stormTimer: StormTimer = realTimer;

let configOverride: FanOutConfigValues | null = null;

export interface FanOutAdmitInput {
  kind: string;
  fingerprint: string;
  /** Clamped one-line summary, kept only for the roster line. */
  message: string;
  /** The kind's own raise, from ReportKindSpec.meta.fanOutPerWindow. */
  fanOutPerWindow?: number;
}

export interface FanOutGate {
  /**
   * Spend one unit of this kind's window budget, if this fingerprint is not
   * already alerting. `{alert: false}` ⇒ the gate took ownership: the
   * occurrence is folded into the kind's storm rollup and writes no row.
   */
  admit(input: FanOutAdmitInput): AlertAdmission;
}

export interface FanOutGateOptions {
  /** Files the rollup. Called once per storm, from the one-shot timer. */
  onStorm: (summary: StormSummary) => void;
}

function readCfg(): FanOutConfigValues {
  return configOverride ?? getConfig(reportsConfig);
}

/**
 * Resolve the ceiling for one admit. A kind may only RAISE its ceiling — the
 * max of the engine default and the kind's own number — so there is no way to
 * express "no ceiling". A non-finite or non-positive raise is a wiring bug in
 * the kind's spec and throws here rather than quietly disabling the mechanism.
 */
function resolveBudget(
  cfg: FanOutConfigValues,
  kind: string,
  kindPerWindow: number | undefined,
): FanOutBudget {
  if (kindPerWindow !== undefined) {
    if (!Number.isInteger(kindPerWindow) || kindPerWindow < 1) {
      throw new Error(
        `ReportKind "${kind}": meta.fanOutPerWindow must be a positive integer ` +
          `(got ${String(kindPerWindow)}). A kind may raise its fan-out ceiling; ` +
          `there is no spelling for removing one.`,
      );
    }
  }
  return {
    distinctPerWindow: Math.max(cfg.fanOutPerWindow, kindPerWindow ?? 0),
    windowMs: cfg.fanOutWindowMs,
    rosterMax: cfg.stormRosterMax,
  };
}

export function createFanOutGate(opts: FanOutGateOptions): FanOutGate {
  const core = createFanOutCore();
  const armed = new Set<string>();

  function onStormTimer(kind: string): void {
    armed.delete(kind);
    const summary = core.takeStorm(kind, Date.now());
    if (!summary) return;
    // Throwing here would reject nothing (a timer callback): the consumer is
    // recordReport's own filing hook, whose failures are already loud through
    // the process crash hooks. Nothing is caught on the way.
    opts.onStorm(summary);
  }

  return {
    admit({ kind, fingerprint, message, fanOutPerWindow }) {
      const cfg = readCfg();
      const budget = resolveBudget(cfg, kind, fanOutPerWindow);
      const admission = core.admit(
        kind,
        fingerprint,
        message,
        Date.now(),
        budget,
      );
      if (!armed.has(kind) && core.stormOwed(kind)) {
        armed.add(kind);
        stormTimer.set(() => onStormTimer(kind), budget.windowMs);
      }
      return admission;
    },
  };
}

/** Override the config read (getConfig needs a booted registry). Pass null to restore. */
export function _setFanOutConfigForTests(
  values: FanOutConfigValues | null,
): void {
  configOverride = values;
}

/** Capture storm arming instead of scheduling real timeouts. Pass null to restore. */
export function _setStormTimerForTests(timer: StormTimer | null): void {
  stormTimer = timer ?? realTimer;
}
