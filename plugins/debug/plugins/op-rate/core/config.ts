import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// Tunable per-kind call-rate thresholds for the op-rate monitor. The scheduled
// monitor job reads these live via getConfig each tick, so changes take effect
// on the next run without a restart. Mirrors slowOpConfig's per-kind shape (one
// defineConfig with field factories rendered for free in Settings → Config).
// Each threshold is "calls in one monitor window" (the cron interval); a kind
// trips when its per-op delta since the previous tick exceeds the threshold.
// `db` / `flush` are inherently high-count (every query / every internal notify
// cycle), so they carry looser thresholds — a single floor would drown the
// signal.
export const opRateConfig = defineConfig({
  name: "op-rate",
  fields: {
    enabled: boolField({
      default: true,
      label: "Enabled",
      description:
        "When off, the monitor job returns early and files no op-rate reports.",
    }),
    httpPerWindow: intField({
      default: 500,
      min: 0,
      label: "HTTP calls per window",
      description:
        "File an op-rate report when an HTTP request label is called more than this many times within one monitor window.",
    }),
    loaderPerWindow: intField({
      default: 500,
      min: 0,
      label: "Loader calls per window",
      description:
        "File an op-rate report when a resource loader label runs more than this many times within one monitor window.",
    }),
    subPerWindow: intField({
      default: 500,
      min: 0,
      label: "Subscription calls per window",
      description:
        "File an op-rate report when a WS-subscription origin entry fires more than this many times within one monitor window.",
    }),
    pushPerWindow: intField({
      default: 500,
      min: 0,
      label: "Push calls per window",
      description:
        "File an op-rate report when a push/cascade origin entry fires more than this many times within one monitor window.",
    }),
    flushPerWindow: intField({
      default: 1000,
      min: 0,
      label: "Flush calls per window",
      description:
        "File an op-rate report when a live-state notify-flush cycle runs more than this many times within one monitor window (internally high-count).",
    }),
    dbPerWindow: intField({
      default: 5000,
      min: 0,
      label: "DB calls per window",
      description:
        "File an op-rate report when a database query label runs more than this many times within one monitor window (leaf-level, naturally high).",
    }),
    jobPerWindow: intField({
      default: 500,
      min: 0,
      label: "Job runs per window",
      description:
        "File an op-rate report when a job label runs more than this many times within one monitor window.",
    }),
    // Per-kind aggregate-time (count×cost) budgets for the op-time trip-wire. Same
    // scheduled monitor, same tick: alongside the call-count delta above, the job
    // diffs each op's cumulative OWN time (its waits excluded — those are the
    // gate's, judged by `waitMsPerWindow`) and trips when a single op did more
    // than this many ms of work inside one monitor window — catching a
    // fast-but-hammered op OR a moderately-called op that is individually slow,
    // neither of which per-call latency (slow-op) nor call count (op-rate) alone
    // sees. Defaults sit well above typical 5-min per-op deltas (single-digit
    // seconds in a healthy env) so a breach is a genuine cost signal. `sub` is
    // tighter (subscription origin work should be cheap); `job` is loosest
    // (backfills/syncs legitimately run long).
    httpMsPerWindow: intField({
      default: 30000,
      min: 0,
      label: "HTTP ms per window",
      description:
        "File an op-time report when an HTTP request label consumes more than this many ms of its own time (waits excluded) within one monitor window.",
    }),
    loaderMsPerWindow: intField({
      default: 60000,
      min: 0,
      label: "Loader ms per window",
      description:
        "File an op-time report when a resource loader label consumes more than this many ms of its own time (waits excluded) within one monitor window.",
    }),
    subMsPerWindow: intField({
      default: 15000,
      min: 0,
      label: "Subscription ms per window",
      description:
        "File an op-time report when a WS-subscription origin entry consumes more than this many ms of its own time (waits excluded) within one monitor window.",
    }),
    pushMsPerWindow: intField({
      default: 30000,
      min: 0,
      label: "Push ms per window",
      description:
        "File an op-time report when a push/cascade origin entry consumes more than this many ms of its own time (waits excluded) within one monitor window.",
    }),
    flushMsPerWindow: intField({
      default: 60000,
      min: 0,
      label: "Flush ms per window",
      description:
        "File an op-time report when a live-state notify-flush cycle consumes more than this many ms of its own time (waits excluded) within one monitor window.",
    }),
    dbMsPerWindow: intField({
      default: 60000,
      min: 0,
      label: "DB ms per window",
      description:
        "File an op-time report when a database query label consumes more than this many ms of its own time (waits excluded) within one monitor window.",
    }),
    jobMsPerWindow: intField({
      default: 120000,
      min: 0,
      label: "Job ms per window",
      description:
        "File an op-time report when a job label consumes more than this many ms of its own time (waits excluded) within one monitor window (backfills/syncs run long, so this is loose).",
    }),
    // A gate's budget: the ms its waiters spent queued on it in one window
    // (summed across concurrent waiters). Ops are judged on their own time, so
    // the time they queued is judged here instead, against the gate.
    waitMsPerWindow: intField({
      default: 60000,
      min: 0,
      label: "Gate wait ms per window",
      description:
        "File an op-time report against a gate (read-admit, db-acquire, heavy-read-local, …) when the operations queued on it waited more than this many ms in total within one monitor window.",
    }),
    rollupFactor: intField({
      default: 4,
      min: 1,
      label: "Rollup factor",
      description:
        "Per-kind rollup trips when the sum of a kind's per-op ms deltas exceeds its per-kind ms budget times this factor — catching cost smeared across many labels, each under its own per-op budget.",
    }),
  },
});
