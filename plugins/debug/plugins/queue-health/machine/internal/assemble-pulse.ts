import {
  HOLD_CLASSES,
  RUNNERS,
  reachableSlots,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/core";
import type {
  DeadJobGroupStat,
  ForfeitedSlot,
  OccupiedSlot,
  PickupStats,
  QueueClassPulse as DbClassPulse,
  WaitingJobStat,
} from "@plugins/infra/plugins/jobs/machine";
import {
  isRecentDeath,
  isStuck,
  queueVerdict,
  waitTone,
  type QueuePulse,
  type QueueVerdictConfig,
  type QueueVerdictResult,
} from "../../core";

// Pure assembly of the Job queue pulse from what the loader read: the slot
// ledger and forfeit registry (memory, exact for this backend) and the three
// bounded queries (the database's view). Kept apart from the loader so the
// joins — which slot counts against which class, what is orphaned — are
// testable without a database. Type-only imports from the jobs server barrel,
// so importing this file loads nothing but the class table.

/** What the verdict alone is built from: the slot ledger and forfeits
 * (memory), the per-class aggregate and the recent deaths (database). */
export interface VerdictReads {
  slots: readonly OccupiedSlot[];
  forfeits: readonly ForfeitedSlot[];
  classes: readonly DbClassPulse[];
  dead: readonly DeadJobGroupStat[];
}

/** Everything the pulse loader read, in one snapshot. */
export interface PulseReads extends VerdictReads {
  pickup: Readonly<Record<HoldClass, PickupStats>>;
  oldestWaiting: readonly WaitingJobStat[];
  pickupWindowMs: number;
}

export interface AssembledPulse {
  pulse: QueuePulse;
  /** The verdict's next change instant — what the loader arms its timer on. */
  nextChangeAt: number | null;
}

/**
 * The verdict alone, from what it reads — the same answer `assemblePulse`
 * gives (`pulse.verdict`), without the listed waiting rows: they move no colour
 * of their own (the class's oldest does), only how the detail marks each one.
 * So `nextChangeAt` here has no instant for those marks either.
 */
export function assembleVerdict(
  reads: VerdictReads,
  cfg: QueueVerdictConfig,
  now: number,
): QueueVerdictResult {
  return queueVerdict(
    {
      classes: slotClasses(reads),
      running: runningJobs(reads, cfg, now),
      waiting: [],
      dead: reads.dead,
    },
    cfg,
    now,
  );
}

export function assemblePulse(
  reads: PulseReads,
  cfg: QueueVerdictConfig,
  now: number,
): AssembledPulse {
  const classes = slotClasses(reads).map((c) => ({
    ...c,
    pickup: { ...reads.pickup[c.hold] },
  }));
  const running = runningJobs(reads, cfg, now);

  const { verdict, nextChangeAt } = queueVerdict(
    {
      classes,
      running,
      waiting: reads.oldestWaiting,
      dead: reads.dead,
    },
    cfg,
    now,
  );

  const lockedRows = classes.reduce((sum, c) => sum + c.lockedCount, 0);
  return {
    pulse: {
      classes: classes.map((c) => ({
        hold: c.hold,
        reachable: c.reachable,
        usable: c.usable,
        busy: c.busy,
        forfeited: c.forfeited,
        waiting: c.waiting,
        oldestWaitingRunAt: c.oldestWaitingRunAt,
        behindLanes: c.behindLanes,
        pickup: c.pickup,
      })),
      running,
      oldestWaiting: reads.oldestWaiting.map((w) => ({
        jobId: w.jobId,
        jobName: w.jobName,
        hold: w.hold,
        runAt: w.runAt,
        attempts: w.attempts,
        tone: waitTone(w.hold, w.runAt, now),
      })),
      dead: reads.dead.map((d) => ({
        jobName: d.jobName,
        count: d.count,
        lastDiedAt: d.lastDiedAt,
        lastError: d.lastError,
        recent: isRecentDeath(d.lastDiedAt, cfg.deadJobAttentionMinutes, now),
      })),
      // Locked in the database, held by no slot here: a worker that died with
      // the row locked. The ledger is read AFTER the queries, so a job that
      // started in between is in the ledger but not yet in the count — which
      // this clamp absorbs, rather than reporting a negative orphan.
      orphanLocked: Math.max(0, lockedRows - reads.slots.length),
      pickupWindowMs: reads.pickupWindowMs,
      verdict,
    },
    nextChangeAt,
  };
}

// Each class joined with the slots that can serve it.
function slotClasses(reads: VerdictReads) {
  return HOLD_CLASSES.map((hold) => {
    const db = reads.classes.find((c) => c.hold === hold);
    if (!db) {
      throw new Error(
        `[queue-health] queryQueuePulse returned no row for class "${hold}" (it zero-fills every class)`,
      );
    }
    // Per-class REACH: every slot on a runner that serves this class, whatever
    // class of job it is running now. A `wide` slot running an instant job is a
    // slot a minutes job cannot have, so it counts as busy for all three.
    const runners = new Set(
      RUNNERS.filter((r) => r.serves.includes(hold)).map((r) => r.id),
    );
    // Union by job id: a forfeited slot is normally still in the ledger (its
    // zombie never completed), but one whose worker died (`worker:fatalError`)
    // has left it — and is still a slot written off.
    const held = new Set<string>();
    for (const s of reads.slots) if (runners.has(s.runnerId)) held.add(s.jobId);
    let forfeited = 0;
    for (const f of reads.forfeits) {
      if (!runners.has(f.runnerId)) continue;
      forfeited++;
      held.add(f.jobId);
    }
    const reachable = reachableSlots(hold);
    return {
      hold,
      reachable,
      usable: reachable - forfeited,
      busy: held.size,
      forfeited,
      waiting: db.waitingForSlot,
      oldestWaitingRunAt: db.oldestWaitingRunAt,
      behindLanes: db.behindLanes,
      nextDueAt: db.nextDueAt,
      lockedCount: db.lockedCount,
    };
  });
}

// Every slot holding a job, longest-held first, marked stuck by the verdict's
// own line.
function runningJobs(
  reads: VerdictReads,
  cfg: QueueVerdictConfig,
  now: number,
) {
  const forfeitedIds = new Set(reads.forfeits.map((f) => f.jobId));
  return [...reads.slots]
    .sort((a, b) => a.lockedAt - b.lockedAt)
    .map((s) => {
      const forfeited = forfeitedIds.has(s.jobId);
      return {
        jobId: s.jobId,
        jobName: s.jobName,
        hold: s.hold,
        runnerId: s.runnerId,
        lockedAt: s.lockedAt,
        forfeited,
        stuck: isStuck(
          { hold: s.hold, lockedAt: s.lockedAt, forfeited },
          cfg.slotHogDeadlineFraction,
          now,
        ),
      };
    });
}
