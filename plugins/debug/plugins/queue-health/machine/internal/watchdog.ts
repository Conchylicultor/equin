import {
  ceilingMsFor,
  deadlineMsFor,
  reachableSlots,
  TOTAL_JOB_SLOTS,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/server";
import {
  queryDeadJobStats,
  queryQueueBacklog,
  queryBacklogByJobName,
  queryRunningJobs,
  type RunningJobStat,
  type QueueBacklogStat,
  type QueueClassBacklogStat,
} from "@plugins/infra/plugins/jobs/machine";
import { getConfig } from "@plugins/config_v2/server";
import { recordReport } from "@plugins/reports/server";
import { getRuntimeProfile } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
import { queueHealthConfig } from "../../core";
import { formatDurationMs } from "../../shared/format-duration";
import { blockedTrip, sampleOf, type JobSpanSample } from "./profile-delta";

// The queue-health watchdog: a raw `setInterval` on the backend's own event
// loop, started from `onReady` and stopped in `onShutdown`.
//
// WHY IT IS NOT A `defineJob` ANY MORE. It used to be one —
// `debug.queue-health-monitor`, `{ cron: "*/5 * * * *", perWorktree: true }` —
// and on 2026-08-17 main's queue wedged for 70 minutes with eleven copies of
// that monitor sitting in the frozen backlog it existed to report. A monitor
// queued behind the failure it detects detects nothing. The doctrine was
// already written down, in this repo, on `jobs/server/internal/stuck-lock-sweeper.ts`:
//
//   "Why this stays a raw setInterval and NOT a scheduled defineJob: it is the
//    recovery mechanism FOR the job system. Routing it through graphile's own
//    queue would mean a wedged worker (the exact failure this clears) couldn't
//    run its own recovery — a deadlock. Infra that recovers the job system must
//    not depend on the job system."
//
// This file is that doctrine applied to the alarm rather than the recovery, and
// it is modeled on the sweeper byte for byte: a `defineTimer`, start/stop
// pair, `.catch → console.warn`, plus an exported
// `queueHealthTickOnce()` for forcing a tick instead of waiting for the next
// one (the sweeper's `sweepOnce`).
//
// WHY IT LIVES IN `debug/queue-health` AND NOT BESIDE THE SWEEPER IN `jobs`: the
// plugin DAG forbids the other placement. `reports/server/internal/record-report.ts`
// imports `recordNotification` from `shell/notifications`, whose barrel imports
// a `defineJob` from `jobs` — so `jobs → reports → shell/notifications → jobs`
// is a cycle, and `no cycles` is enforced by `./singularity check
// plugin-boundaries`. This plugin already imports both `jobs` and `reports`, so
// the placement adds zero new plugin edges, and it keeps queue INTERPRETATION
// (thresholds, config, report kinds) out of the load-bearing mechanism-only
// `jobs` plugin.
//
// Known escalation, deliberately not built: this rides the same event loop it
// watches, so a wedged LOOP silences it. That failure class belongs one level
// lower — the sentinel's worker thread — per the rule that a monitor runs
// exactly one level below the subsystem it watches, and no lower.

// 30s, so six samples fit in the default three-minute wedge window. The window
// is the trip condition; the cadence only decides how many independent samples
// prove it. At six, one slow or skipped tick cannot false-negative a real wedge
// — and the wedge test needs consecutive samples of an UNCHANGED locked set, so
// too few samples would make a single lucky sample decide an outage alarm.
//
// A module constant, not config, for the same reason the sweeper's
// `SWEEP_INTERVAL_MS` is: it is a property of the detector, not a threshold an
// operator tunes. `wedgeMinutes` is the tunable one.
const TICK_MS = 30_000;

// Terminally-dead jobs do not need 30s resolution — a dead-letter is dead until
// someone retries it, and its report dedups per jobName anyway. Sampling it
// every 10th tick keeps the healthy path at two aggregates plus a `pg_locks`
// scan bounded by the slot count, and preserves the 5-minute cadence the
// scheduled monitor used to give it.
const DEAD_JOB_EVERY_N_TICKS = 10;

// The slot-blocked check reads the WHOLE runtime profile (every label of every
// span kind, materialized fresh), which is far heavier than this watchdog's two
// bounded queue aggregates — so it runs every 10th tick rather than every tick,
// matching `debug/op-rate`, the other consumer that diffs the same profile.
//
// The cadence is also the measurement window: the check averages hold and wait
// over the runs that COMPLETED since the last sample, and five minutes of runs
// average better than thirty seconds of them. Blocking on an admission gate is
// a standing condition, not an instant — nothing is lost by looking less often.
const SLOT_BLOCKED_EVERY_N_TICKS = 10;

// How far the derived head-of-queue timestamp may drift between two samples and
// still count as "the same row is still at the head". The head's `run_at` is
// derived as `sampleWallClock - oldestOverdueMs`, so it carries this backend's
// clock skew against Postgres (constant between samples, therefore cancelling)
// plus per-query latency (tens of ms, occasionally more under load). One second
// swallows the jitter without hiding a real advance: when a class actually
// drains, its readyCount falls, which resets the candidate regardless.
const HEAD_DRIFT_TOLERANCE_MS = 1_000;

let tickCount = 0;

// The ONLY state the wedge detector carries: which slots were held at the last
// sample, and when that exact set was first seen. A wedge is "this set has not
// changed", which no single sample can express. Cleared the moment any of the
// four conditions stops holding, so a queue that resumes draining starts the
// clock over rather than tripping on stale evidence.
//
// One entry, deliberately: the wedge detector is GLOBAL. It is about the whole
// pool stopping — every slot on every runner — which is a different claim from
// "one tier stopped draining". That per-class claim is `checkClassStarvation`
// below, which carries its own per-class candidates.
let wedgeCandidate: { ids: Set<string>; since: number } | null = null;

// Per-class starvation evidence: the head-of-queue timestamp and ready depth
// when this class's candidate was opened. Same shape as `wedgeCandidate` and
// cleared under the same rule — the moment the class shows any sign of
// draining, the clock starts over.
const starvedCandidates = new Map<
  HoldClass,
  { headRunAtMs: number; readyCount: number; since: number }
>();

// Per-jobName baseline of the runtime profiler's cumulative job-span counters at
// the previous slot-blocked sample. The profiler accumulates since boot, so the
// only way to ask "was this job blocked RECENTLY" is to diff two samples. Lives
// at module scope because the recorder and this watchdog run in the SAME
// process — the same argument `debug/op-rate`'s baseline maps make. Bounded by
// the number of distinct job names.
const lastJobSample = new Map<string, JobSpanSample>();
let lastJobSampleAtMs = 0;

export const queueHealthTimer = defineTimer({
  name: "queue-health.watchdog",
  description:
    "Samples the job queue every 30 seconds and files a report when it wedges, starves, backs up, or a job hogs a slot.",
  everyMs: TICK_MS,
  run: () =>
    // eslint-disable-next-line promise-safety/no-bare-catch
    queueHealthTickOnce().catch((err) => {
      console.warn("[queue-health] watchdog tick failed", err);
    }),
});

export function startQueueHealthWatchdog(): void {
  queueHealthTimer.start();
}

export function stopQueueHealthWatchdog(): void {
  if (queueHealthTimer.running) {
    queueHealthTimer.stop();
    // Drop the evidence with the timer. A restarted watchdog has not observed
    // anything yet, and a set of ids (or a head timestamp, or a counter
    // baseline) captured before a shutdown says nothing about the queue after
    // it — a stale baseline would report a whole downtime as one window.
    wedgeCandidate = null;
    starvedCandidates.clear();
    lastJobSample.clear();
    lastJobSampleAtMs = 0;
  }
}

// One sample of the queue. Exported so a caller can force a tick instead of
// waiting up to 30s for the next one — the same role `sweepOnce` plays for the
// stuck-lock sweeper.
//
// Reads the queue through the jobs plugin's read-only introspection API, which
// owns the graphile-internals coupling (the per-class task identifiers, the
// `payload->>'jobName'` encoding, the ready/dead predicates, the `pg_locks` key
// encoding behind `alive`), so this watchdog can never drift from how the queue
// is actually encoded. Reports fire only on a tripped threshold — silent when
// healthy.
export async function queueHealthTickOnce(): Promise<void> {
  const cfg = getConfig(queueHealthConfig);
  if (!cfg.enabled) return;

  const tick = tickCount++;

  // Both aggregates are taken ONCE per tick and shared by all four live checks
  // — backlog, class-starvation, slot-hog and wedge all read the same snapshot.
  // That matters beyond cost: the wedge test compares a locked-id set against a
  // locked count, and two separate queries could disagree about a slot that
  // freed between them, which would read as "the set changed" and reset the
  // clock forever.
  const [backlog, running] = await Promise.all([
    queryQueueBacklog(),
    queryRunningJobs(),
  ]);

  await checkWedge(backlog, running, cfg.wedgeMinutes);
  await checkClassStarvation(backlog, cfg.wedgeMinutes);
  await checkBacklog(
    backlog,
    cfg.backlogDepthThreshold,
    cfg.oldestOverdueMinutes,
  );
  await checkSlotHogs(running, cfg.slotHogDeadlineFraction);

  if (tick % SLOT_BLOCKED_EVERY_N_TICKS === 0)
    await checkSlotBlocked(cfg.slotBlockedWaitSeconds * 1000);
  if (tick % DEAD_JOB_EVERY_N_TICKS === 0) await checkDeadJobs();
}

// The queue has stopped draining — GLOBALLY. Four conditions, all of which must
// hold continuously for `wedgeMinutes`:
//
//   1. every slot is held (`running.length >= TOTAL_JOB_SLOTS` — `>=` because a
//      locked row briefly outliving its slot must not un-trip a real wedge);
//   2. the set of locked job ids is UNCHANGED since the candidate was opened —
//      this is the one that separates "wedged" from "busy". A saturated pool
//      that is completing jobs churns its ids every tick and never trips;
//   3. `readyCount > 0` — work is actually being starved. A pool fully held by
//      long jobs with an empty queue behind them is a busy machine, not an
//      outage;
//   4. every holder is `alive` — its advisory lock is held by a live backend.
//      A row whose owner DIED is the stuck-lock sweeper's job, and it will
//      reclaim it within a minute; reporting it here would double-report a
//      condition that is already recovering itself.
//
// This detector stays GLOBAL on purpose. The runner ladder made "one tier
// stopped draining" a separate, weaker claim — which is `queue-class-starved`
// below. This one is still exactly right for what it says: every slot on every
// runner is frozen, so nothing of ANY class can start. The report copy now
// carries the per-class occupancy alongside it, so an operator can see which
// tier the frozen rows belong to without a second query.
async function checkWedge(
  backlog: QueueBacklogStat,
  running: RunningJobStat[],
  wedgeMinutes: number,
): Promise<void> {
  const saturated = running.length >= TOTAL_JOB_SLOTS;
  const starving = backlog.readyCount > 0;
  const allAlive = running.every((r) => r.alive);

  if (!saturated || !starving || !allAlive) {
    wedgeCandidate = null;
    return;
  }

  const ids = new Set(running.map((r) => r.jobId));
  const now = Date.now();
  if (!wedgeCandidate || !sameSet(wedgeCandidate.ids, ids)) {
    // First sample of this exact locked set. Open a candidate and wait — one
    // sample can never prove nothing is completing.
    wedgeCandidate = { ids, since: now };
    return;
  }
  if (now - wedgeCandidate.since < wedgeMinutes * 60_000) return;

  // How long the slots have been held, read off graphile's `locked_at` rather
  // than off `wedgeCandidate.since`. Every slot has been held AT LEAST this
  // long, which stays true when a backend boots into an already-wedged queue —
  // our own observation window would understate it to `wedgeMinutes`.
  const heldForMs = Math.min(...running.map((r) => r.lockedForMs));

  // Attribute who is starved. Only fetched on the already-tripped path, so the
  // healthy 30s tick stays two aggregate queries.
  const topReady = await queryBacklogByJobName();

  await recordReport({
    kind: "queue-wedged",
    source: "server-queue-monitor",
    data: {
      concurrency: TOTAL_JOB_SLOTS,
      readyCount: backlog.readyCount,
      heldForMs,
      holders: running.map((r) => ({
        jobName: r.jobName,
        jobId: r.jobId,
        lockedForMs: r.lockedForMs,
      })),
      topReady,
      classes: occupancy(backlog.classes),
    },
    message:
      `queue wedged — ${running.length}/${TOTAL_JOB_SLOTS} slots held ` +
      `≥${formatDurationMs(heldForMs)} by ${summarizeHolders(running)}; ` +
      `${backlog.readyCount} ready (${summarizeClasses(backlog.classes)})`,
  });
}

// ONE tier of the runner ladder has stopped draining, while the pool as a whole
// may be perfectly healthy. This is the signal that VERIFIES the reservation:
// if reserving two slots for `instant` work actually works, this kind never
// fires for `instant`, and if it does, the ladder is not doing its job. It is
// also the signal that would have named the 40-minute `tasks.push-ingest` lag
// that started this design — a whole class of work not moving while the queue
// looked busy.
//
// WHY "DID ANYTHING DRAIN" AND NOT "IS THIS TIER SATURATED". The obvious test —
// count the slots this class is occupying and compare against `reachableSlots`
// — is not answerable: the three runners share one `_private_jobs` table and
// graphile records no runner id per row, so a locked row cannot be attributed to
// the runner holding it. "Is the seconds tier full" therefore has no answer.
// "Did anything in this class drain" does, it is exact, and it costs nothing
// beyond the aggregate this tick already took.
//
// Two conditions, both continuous for the class's own window:
//
//   1. the HEAD DID NOT MOVE. The class's oldest ready row is also the next row
//      graphile will pick from it (`getJob` orders `priority asc, run_at asc`,
//      and every row of a class carries that class's priority), so a head that
//      has not advanced means nothing was taken off the front. The head is
//      identified by its `run_at`, derived as `now - oldestOverdueMs` — an
//      unmoved head's derived timestamp is constant, while a drained one jumps
//      forward to the next row's.
//   2. the READY DEPTH DID NOT FALL below where the candidate opened. This is
//      what keeps a fan-out burst honest: `emit()` writes N rows with nearly
//      identical `run_at`, so a burst DRAINING still looks like a frozen head
//      within the drift tolerance — but its depth falls every tick, which resets
//      the candidate.
//
// KNOWN RESIDUAL, stated rather than papered over. A row can be ready and still
// unpickable: graphile's fetch skips a row whose `serial` queue name is locked
// by a running sibling. If such a row sits at the head while the rest of the
// class drains AND arrivals keep the depth at or above the candidate's opening
// value, both conditions hold and this fires — a real stall of that class's
// head, but caused by one blocked lane rather than by the ladder. Ruling it out
// would need a per-class COMPLETION counter, which nothing exposes today: the
// runtime profiler counts completions per jobName, not per class, and mapping
// one to the other would mean reaching into the job registry from here. The
// depth condition catches the common shape (the class visibly drains) and the
// report names the jobs at the head, which is enough to tell the two apart by
// eye.
//
// The window is the LONGER of `wedgeMinutes` and the class's own work ceiling.
// A flat three minutes would be nonsense for `minutes`, whose conforming runs
// may legitimately hold every reachable slot for half an hour; three minutes of
// a frozen `instant` head, whose ceiling is ten seconds, is already damning.
async function checkClassStarvation(
  backlog: QueueBacklogStat,
  wedgeMinutes: number,
): Promise<void> {
  const now = Date.now();

  for (const c of backlog.classes) {
    if (c.readyCount === 0) {
      starvedCandidates.delete(c.hold);
      continue;
    }

    const headRunAtMs = now - c.oldestOverdueMs;
    const prev = starvedCandidates.get(c.hold);
    const headFrozen =
      prev !== undefined &&
      Math.abs(headRunAtMs - prev.headRunAtMs) <= HEAD_DRIFT_TOLERANCE_MS;
    const drained = prev !== undefined && c.readyCount < prev.readyCount;

    if (!prev || !headFrozen || drained) {
      // Either the first sample of this class's head, or evidence that it is
      // moving. Re-open the candidate from here — the opening `readyCount` is
      // the floor condition 2 tests against for the rest of the window.
      starvedCandidates.set(c.hold, {
        headRunAtMs,
        readyCount: c.readyCount,
        since: now,
      });
      continue;
    }

    const windowMs = Math.max(wedgeMinutes * 60_000, ceilingMsFor(c.hold));
    if (now - prev.since < windowMs) continue;

    // Attribute the starvation to the jobs actually sitting in this class's
    // ready queue. Fetched deep and filtered rather than taken from the default
    // top-5: that top-5 ranks across ALL classes, so a starved class whose rows
    // are a small fraction of a busy queue would not appear in it at all. Only
    // on the already-tripped path, so the healthy tick is unaffected.
    const topReady = (await queryBacklogByJobName(50))
      .filter((j) => j.hold === c.hold)
      .slice(0, 5);

    await recordReport({
      kind: "queue-class-starved",
      source: "server-queue-monitor",
      data: {
        hold: c.hold,
        reachableSlots: reachableSlots(c.hold),
        readyCount: c.readyCount,
        lockedCount: c.lockedCount,
        oldestOverdueMs: c.oldestOverdueMs,
        starvedForMs: now - prev.since,
        windowMs,
        classes: occupancy(backlog.classes),
        topReady,
      },
      message:
        `${c.hold} class starved — nothing drained for ` +
        `${formatDurationMs(now - prev.since)}; ${c.readyCount} ready, ` +
        `oldest ${formatDurationMs(c.oldestOverdueMs)}, ` +
        `${reachableSlots(c.hold)} slots reachable`,
    });
  }
}

// Terminally-dead jobs grouped by jobName → one report per distinct jobName.
async function checkDeadJobs(): Promise<void> {
  const stats = await queryDeadJobStats();
  for (const s of stats) {
    await recordReport({
      kind: "queue-dead-job",
      source: "server-queue-monitor",
      data: {
        jobName: s.jobName,
        deadCount: s.deadCount,
        attempts: s.attempts,
        maxAttempts: s.maxAttempts,
        lastError: s.lastError,
        sampleJobId: s.sampleJobId,
      },
      message: `${s.jobName} ×${s.deadCount}${
        s.lastError ? ` — ${firstLine(s.lastError)}` : ""
      }`,
    });
  }
}

// Queue depth/stall. Trips on either depth or staleness; `stalled` = overdue but
// nothing running (the worker is making no progress).
async function checkBacklog(
  backlog: QueueBacklogStat,
  backlogDepthThreshold: number,
  oldestOverdueMinutes: number,
): Promise<void> {
  const { readyCount, lockedCount, oldestOverdueMs } = backlog;
  const oldestThresholdMs = oldestOverdueMinutes * 60_000;

  const stalled = lockedCount === 0 && oldestOverdueMs > oldestThresholdMs;
  const tripped =
    readyCount > backlogDepthThreshold || oldestOverdueMs > oldestThresholdMs;
  if (!tripped) return;

  // Attribute the rollup: which jobs are filling the ready queue. Only fetched
  // when the threshold has already tripped, so the healthy path stays two
  // aggregate queries.
  const topReady = await queryBacklogByJobName();

  await recordReport({
    kind: "queue-backlog",
    source: "server-queue-monitor",
    data: { readyCount, oldestOverdueMs, lockedCount, stalled, topReady },
    message: stalled
      ? `STALLED — ${readyCount} ready, 0 running, oldest overdue ${Math.round(
          oldestOverdueMs / 1000,
        )}s`
      : `${readyCount} ready, ${lockedCount} running, oldest overdue ${Math.round(
          oldestOverdueMs / 1000,
        )}s`,
  });
}

// Slot-hogging: a job holding a worker slot far longer than its declared class
// says one run may. Collapse the currently-locked rows to the longest-held per
// jobName, then file one report per jobName over its class's threshold.
//
// HOLD vs WORK, resolved deliberately. A class's ceiling is defined on WORK
// (`durationMs - waitMs`), because slot-hold is substantially not a property of
// the job — a handler blocked on an admission gate entered after dispatch can
// hold a slot for a minute to do 250ms of work. But a locked graphile row
// carries only `locked_at`, so HOLD is the only quantity this detector can see
// at all; the work/wait split lives in the in-memory profiler and is only final
// once the run ends.
//
// So this detector stays on hold, and it compares against the one number that
// is ALSO defined on hold: the class's deadline (`deadlineMsFor`), the
// wall-clock point at which a run of that class is aborted. The threshold is a
// fraction of it (`slotHogDeadlineFraction`, default 0.5), constrained strictly
// below 1 by its field definition — so warn-before-kill is true by construction
// for every class at every settable value, rather than a coincidence of two
// numbers chosen independently. Comparing a hold against a WORK ceiling was the
// tension this replaced; the gap between the ceiling and the deadline is exactly
// the gate wait a conforming handler is allowed.
//
// When the excess IS wait rather than work, `queue-slot-blocked` says so
// exactly, by name of the gate; the two detectors are complements, not rivals,
// and a genuinely blocked job trips both with the second one carrying the
// actionable half.
//
// Per class rather than one flat duration, which is the point: a `minutes` job
// holding a slot for six minutes is doing exactly what it declared, while an
// `instant` job holding one for six minutes has wedged a reserved floor slot and
// is the ladder's new failure mode.
async function checkSlotHogs(
  running: RunningJobStat[],
  slotHogDeadlineFraction: number,
): Promise<void> {
  // queryRunningJobs is ordered by lockedForMs DESC, so the first row seen for a
  // jobName is its longest-held slot. Its `hold` is the class used for the
  // threshold: mid-deploy one jobName can briefly have rows on two tasks (its
  // class's and the legacy one), and the longest-held row is the one the report
  // is about. Also count concurrent rows for that job.
  const longestPerJob = new Map<
    string,
    {
      hold: HoldClass;
      lockedForMs: number;
      sampleJobId: string;
      runningCount: number;
    }
  >();
  for (const r of running) {
    const existing = longestPerJob.get(r.jobName);
    if (existing) {
      existing.runningCount += 1;
    } else {
      longestPerJob.set(r.jobName, {
        hold: r.hold,
        lockedForMs: r.lockedForMs,
        sampleJobId: r.jobId,
        runningCount: 1,
      });
    }
  }

  for (const [jobName, agg] of longestPerJob) {
    const thresholdMs = deadlineMsFor(agg.hold) * slotHogDeadlineFraction;
    if (agg.lockedForMs <= thresholdMs) continue;
    await recordReport({
      kind: "queue-slot-hog",
      source: "server-queue-monitor",
      data: {
        jobName,
        hold: agg.hold,
        thresholdMs,
        lockedForMs: agg.lockedForMs,
        runningCount: agg.runningCount,
        sampleJobId: agg.sampleJobId,
      },
      message:
        `${jobName} (${agg.hold}) holding a slot for ` +
        `${formatDurationMs(agg.lockedForMs)} — over ${formatDurationMs(
          thresholdMs,
        )}`,
    });
  }
}

// A job that holds a worker slot to WAIT rather than to work: an admission gate
// entered AFTER graphile handed over the slot. `jobs.dead-gc` was measured
// holding a slot for 77 seconds to do 254ms of work, all of it blocked on
// `background-tx-acquire` — the exact pathology `serial` exists to eliminate,
// occurring system-wide through the DB lane gates, and completely invisible
// until now: "slow job" is the wrong description of it and leads to the wrong
// fix (reclassify it) instead of the right one (stop entering a gate on a
// worker slot).
//
// WHERE THE DATA COMES FROM, and why it is not the live queue. `queryRunningJobs`
// gives locked rows with `lockedForMs`, which is hold — it has no idea what the
// handler is doing inside that hold. The wait/work split exists only in the
// runtime profiler's in-memory `job` spans, and only there. Two consequences,
// both accepted rather than worked around:
//
//   - This is necessarily POST-HOC. Gates charge their wait through
//     `chargeWait(layer, elapsed)` when the wait ENDS, so a job blocked right
//     now carries no wait yet; there is nothing to sample about a currently
//     blocked job. Reading completed runs is the only exact answer, so this
//     detector reads completed runs.
//   - The profiler is per-process in-memory state, so this sees the runs THIS
//     backend executed. That is the right scope — this backend is the one
//     draining this worktree's queue — and it is the same scope
//     `debug/op-rate`'s `perWorktree` monitor works at.
//
// The span wraps `job.run()` only, so its duration is the HANDLER's hold and
// excludes graphile's handover and the job-lock connect ahead of it — a
// sub-second sliver, and one that makes the reported hold a slight
// UNDER-statement of the slot's true occupancy rather than an over-statement.
async function checkSlotBlocked(floorMs: number): Promise<void> {
  const { aggregates } = getRuntimeProfile();
  const now = Date.now();
  const windowMs = lastJobSampleAtMs === 0 ? 0 : now - lastJobSampleAtMs;
  lastJobSampleAtMs = now;

  for (const agg of aggregates.job) {
    const prev = lastJobSample.get(agg.label);
    const cur = sampleOf(agg);
    lastJobSample.set(agg.label, cur);
    // First observation of this job seeds the baseline and fires nothing —
    // otherwise a backend up for a day would report its whole history as one
    // window. Same seed rule as op-rate's `windowDelta`.
    if (!prev) continue;

    const trip = blockedTrip(prev, cur, floorMs);
    if (!trip) continue;

    await recordReport({
      kind: "queue-slot-blocked",
      source: "server-queue-monitor",
      data: {
        jobName: agg.label,
        runs: trip.runs,
        windowMs,
        holdMs: Math.round(trip.holdMs),
        waitMs: Math.round(trip.waitMs),
        workMs: Math.round(trip.workMs),
        layer: trip.layer,
        layerMs: Math.round(trip.layerMs),
        layers: trip.layers.map((l) => ({
          layer: l.layer,
          ms: Math.round(l.ms),
        })),
      },
      message:
        `${agg.label} held a slot ${formatDurationMs(trip.holdMs)} to do ` +
        `${formatDurationMs(trip.workMs)} of work, blocked on ${trip.layer}`,
    });
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// The per-class occupancy carried by the wedge and starvation payloads: the
// class's own depth numbers paired with the ladder's `reachableSlots`. One
// helper so both reports state the tier the same way.
function occupancy(classes: QueueClassBacklogStat[]) {
  return classes.map((c) => ({
    hold: c.hold,
    reachableSlots: reachableSlots(c.hold),
    readyCount: c.readyCount,
    lockedCount: c.lockedCount,
  }));
}

// "instant 12 ready/0 running, minutes 1 ready/4 running" — the per-class
// breakdown for a one-line report message. Classes with nothing in them at all
// are dropped, so the line stays short when only one tier is involved.
function summarizeClasses(classes: QueueClassBacklogStat[]): string {
  const parts = classes
    .filter((c) => c.readyCount > 0 || c.lockedCount > 0)
    .map((c) => `${c.hold} ${c.readyCount} ready/${c.lockedCount} running`);
  return parts.length > 0 ? parts.join(", ") : "no rows";
}

// "prototypes.render-thumbnail ×3, worktree-cleanup.reap-stale" — who is on the
// slots, deepest first, for the one-line report message.
function summarizeHolders(running: RunningJobStat[]): string {
  const counts = new Map<string, number>();
  for (const r of running)
    counts.set(r.jobName, (counts.get(r.jobName) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([jobName, n]) => (n > 1 ? `${jobName} ×${n}` : jobName))
    .join(", ");
}

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? s;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
