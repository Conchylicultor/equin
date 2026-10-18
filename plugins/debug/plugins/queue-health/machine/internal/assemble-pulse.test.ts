import { describe, expect, test } from "bun:test";
import {
  HOLD_CLASSES,
  RUNNERS,
  deadlineMsFor,
  reachableSlots,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/core";
import type {
  ForfeitedSlot,
  OccupiedSlot,
  PickupStats,
  QueueClassPulse,
} from "@plugins/infra/plugins/jobs/machine";
import { QueuePulseSchema } from "../../core/pulse";
import { assemblePulse, type PulseReads } from "./assemble-pulse";

// The joins the loader cannot get wrong silently: which runner's slots count
// against which class's bar, how forfeits and the ledger combine, and what is
// orphaned. Runner ids and slot counts are read from the ladder, never spelled.

const NOW = 1_800_000_000_000;
const CFG = { slotHogDeadlineFraction: 0.5, deadJobAttentionMinutes: 60 };

const NO_PICKUPS: PickupStats = {
  count: 0,
  p50Ms: null,
  p95Ms: null,
  maxMs: null,
};

function dbClasses(
  overrides: Partial<Record<HoldClass, Partial<QueueClassPulse>>> = {},
): QueueClassPulse[] {
  return HOLD_CLASSES.map((hold) => ({
    hold,
    waitingForSlot: 0,
    oldestWaitingRunAt: null,
    behindLanes: 0,
    lockedCount: 0,
    nextDueAt: null,
    ...overrides[hold],
  }));
}

function reads(partial: Partial<PulseReads> = {}): PulseReads {
  return {
    slots: [],
    forfeits: [],
    pickup: Object.fromEntries(
      HOLD_CLASSES.map((h) => [h, NO_PICKUPS]),
    ) as Record<HoldClass, PickupStats>,
    classes: dbClasses(),
    oldestWaiting: [],
    dead: [],
    pickupWindowMs: 900_000,
    ...partial,
  };
}

let nextId = 0;
function slot(
  runnerId: string,
  extra: Partial<OccupiedSlot> = {},
): OccupiedSlot {
  nextId++;
  return {
    workerId: `w${nextId}`,
    runnerId,
    jobId: `j${nextId}`,
    jobName: `job-${nextId}`,
    hold: "instant",
    runAt: NOW - 10,
    lockedAt: NOW - 5,
    attempt: 1,
    ...extra,
  };
}

// The runner that serves only the shortest class, and the one that serves all.
const narrowest = RUNNERS.find((r) => r.serves.length === 1)!;
const widest = RUNNERS.find((r) => r.serves.length === HOLD_CLASSES.length)!;

describe("per-class reach", () => {
  test("a slot counts as busy for every class its runner serves", () => {
    const { pulse } = assemblePulse(
      reads({ slots: [slot(widest.id)] }),
      CFG,
      NOW,
    );
    for (const c of pulse.classes) {
      expect(c.reachable).toBe(reachableSlots(c.hold));
      expect(c.busy).toBe(1);
    }
  });

  test("a slot on a narrow runner is busy only for the classes it serves", () => {
    const { pulse } = assemblePulse(
      reads({ slots: [slot(narrowest.id)] }),
      CFG,
      NOW,
    );
    for (const c of pulse.classes) {
      expect(c.busy).toBe(narrowest.serves.includes(c.hold) ? 1 : 0);
    }
  });

  test("a forfeited slot is busy, forfeited, and not usable", () => {
    const s = slot(widest.id, { hold: "minutes" });
    const forfeit: ForfeitedSlot = {
      jobId: s.jobId,
      jobName: s.jobName,
      hold: "minutes",
      runnerId: widest.id,
      since: NOW,
    };
    const { pulse } = assemblePulse(
      reads({ slots: [s], forfeits: [forfeit] }),
      CFG,
      NOW,
    );
    for (const c of pulse.classes) {
      expect(c.busy).toBe(1);
      expect(c.forfeited).toBe(1);
      expect(c.usable).toBe(reachableSlots(c.hold) - 1);
    }
    expect(pulse.running[0]).toMatchObject({ forfeited: true, stuck: true });
    expect(pulse.verdict.state).toBe("attention");
  });

  test("a forfeit whose worker already left the ledger still holds its slot", () => {
    const forfeit: ForfeitedSlot = {
      jobId: "gone",
      jobName: "zombie",
      hold: "minutes",
      runnerId: widest.id,
      since: NOW,
    };
    const { pulse } = assemblePulse(
      reads({ slots: [slot(widest.id)], forfeits: [forfeit] }),
      CFG,
      NOW,
    );
    const minutes = pulse.classes.find((c) => c.hold === "minutes")!;
    expect(minutes.busy).toBe(2);
    expect(minutes.forfeited).toBe(1);
  });
});

describe("running rows", () => {
  test("are sorted longest-held first and marked stuck at the slot-hog line", () => {
    const line = CFG.slotHogDeadlineFraction * deadlineMsFor("seconds");
    const young = slot(widest.id, { hold: "seconds", lockedAt: NOW - 1 });
    const old = slot(widest.id, { hold: "seconds", lockedAt: NOW - line });
    const { pulse } = assemblePulse(reads({ slots: [young, old] }), CFG, NOW);
    expect(pulse.running.map((r) => r.jobId)).toEqual([old.jobId, young.jobId]);
    expect(pulse.running.map((r) => r.stuck)).toEqual([true, false]);
  });
});

describe("orphaned locks", () => {
  test("rows locked in the database with no slot here are orphaned", () => {
    const { pulse } = assemblePulse(
      reads({
        slots: [slot(widest.id)],
        classes: dbClasses({
          instant: { lockedCount: 2 },
          minutes: { lockedCount: 1 },
        }),
      }),
      CFG,
      NOW,
    );
    expect(pulse.orphanLocked).toBe(2);
  });

  test("a slot that started after the query is never a negative orphan", () => {
    const { pulse } = assemblePulse(
      reads({ slots: [slot(widest.id), slot(widest.id)] }),
      CFG,
      NOW,
    );
    expect(pulse.orphanLocked).toBe(0);
  });
});

describe("the payload", () => {
  test("parses against its own schema", () => {
    const { pulse } = assemblePulse(
      reads({
        slots: [slot(widest.id)],
        classes: dbClasses({
          seconds: {
            waitingForSlot: 2,
            oldestWaitingRunAt: NOW - 1000,
            behindLanes: 1,
          },
        }),
        oldestWaiting: [
          {
            jobId: "w1",
            jobName: "a",
            hold: "seconds",
            runAt: NOW - 1000,
            attempts: 0,
          },
        ],
        dead: [
          { jobName: "d", count: 2, lastDiedAt: NOW - 1000, lastError: "boom" },
          {
            jobName: "old",
            count: 1,
            lastDiedAt: NOW - 2 * 3_600_000,
            lastError: null,
          },
        ],
      }),
      CFG,
      NOW,
    );
    expect(QueuePulseSchema.safeParse(pulse).success).toBe(true);
    expect(pulse.dead.map((d) => d.recent)).toEqual([true, false]);
    expect(pulse.oldestWaiting[0]!.tone).toBe("ok");
    expect(pulse.verdict.summary).toBe("d failed ×2");
  });

  test("a class missing from the database read is a loud error", () => {
    expect(() =>
      assemblePulse(reads({ classes: dbClasses().slice(1) }), CFG, NOW),
    ).toThrow(/no row for class/);
  });
});
