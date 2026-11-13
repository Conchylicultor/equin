import { describe, expect, test } from "bun:test";
import { PER_UNIT_BYTES, type HostFacts } from "./budget";
import { holderReserve, peaksByWork, type HolderReading } from "./holders";
import {
  fleetAdmission,
  fleetCharge,
  fleetWindow,
  FLEET_MEMORY_LEASE_MS,
  laneCapacity,
  unmeasuredWindow,
  type FleetMemoryReading,
} from "./fleet-memory";

// The 64 GB / 18-core box the incidents were measured on: B = 9.
const BOX: HostFacts = { cpus: 18, ramBytes: 68.72e9 };
const GB = 1e9;

function reading(r: Partial<FleetMemoryReading>): FleetMemoryReading {
  return {
    sampledAt: 0,
    ramBytes: BOX.ramBytes,
    wiredBytes: 5 * GB,
    otherBytes: 20 * GB,
    opsBytes: 0,
    heldUnits: 0,
    holders: [],
    ...r,
  };
}

describe("fleetWindow", () => {
  test("a quiet host gets the whole static ceiling, never more", () => {
    expect(fleetWindow(reading({}), BOX).slots).toBe(9);
  });

  test("the rest of the machine's measured use shrinks it", () => {
    // 68.72 − 5 − 50 = 13.72 GB left → 3 quanta.
    expect(fleetWindow(reading({ otherBytes: 50 * GB }), BOX).slots).toBe(3);
  });

  test("a held slot reserves a quantum before its holder has grown", () => {
    const w = fleetWindow(
      reading({ otherBytes: 50 * GB, heldUnits: 2, opsBytes: 1 * GB }),
      BOX,
    );
    expect(w.chargedBytes).toBe(2 * PER_UNIT_BYTES);
    expect(w.slots).toBe(3);
  });

  test("holders' own memory is charged: measured use above the reservation shrinks it", () => {
    // Two slots held, but the ops (two builds + their nested checks + workers)
    // measure 13 GB: 13.72 − 13 leaves no further quantum, and the window is
    // BELOW what is held, so no new slot is taken until some are released.
    const w = fleetWindow(
      reading({ otherBytes: 50 * GB, heldUnits: 2, opsBytes: 13 * GB }),
      BOX,
    );
    expect(w.chargedBytes).toBe(13 * GB);
    expect(w.slots).toBe(2);
  });

  test("never below one slot, so the line always moves", () => {
    expect(fleetWindow(reading({ otherBytes: 70 * GB }), BOX).slots).toBe(1);
  });

  // The 2026-11-12 overload (main's health-owners log, wired ≈ 5 GB).
  test("04:00:07 — Chrome 38.5 GB, 61.9 GB of non-op use: one slot", () => {
    const w = fleetWindow(
      reading({ otherBytes: 61.9 * GB, opsBytes: 18.7 * GB, heldUnits: 5 }),
      BOX,
    );
    expect(w.slots).toBe(1);
  });

  test("04:24:38 — 42.7 GB non-op, ops at 27.1 GB: no slot beyond those held", () => {
    const w = fleetWindow(
      reading({ otherBytes: 42.7 * GB, opsBytes: 27.1 * GB, heldUnits: 6 }),
      BOX,
    );
    // 21.0 GB left for the fleet, charged 27.1: a 4-slot window under 6 held.
    expect(w.slots).toBe(4);
  });
});

function holder(h: Partial<HolderReading>): HolderReading {
  return {
    work: "build",
    units: 1,
    bytes: 0,
    reserveBytes: PER_UNIT_BYTES,
    reserveBasis: "unmeasured",
    ...h,
  };
}

describe("fleetCharge", () => {
  test("no holder markers: exactly the old max(held × quantum, measured)", () => {
    const r = reading({ heldUnits: 6, opsBytes: 2 * GB });
    expect(fleetCharge(r).bytes).toBe(6 * PER_UNIT_BYTES);
    expect(
      fleetCharge(reading({ heldUnits: 2, opsBytes: 13 * GB })).bytes,
    ).toBe(13 * GB);
  });

  test("unmeasured work keeps the whole quantum per slot", () => {
    // The 2026-11-13 queued build: 6 slots, 2.0 GB measured, nothing recorded.
    const r = reading({
      heldUnits: 6,
      opsBytes: 2 * GB,
      holders: [
        holder({ units: 5, bytes: 1.5 * GB, reserveBytes: 5 * PER_UNIT_BYTES }),
        holder({ work: "test", units: 1, bytes: 0.5 * GB }),
      ],
    });
    expect(fleetCharge(r).bytes).toBeCloseTo(6 * PER_UNIT_BYTES);
  });

  test("a measured reservation charges a share what its work peaks at", () => {
    const r = reading({
      otherBytes: 40 * GB,
      heldUnits: 6,
      opsBytes: 2 * GB,
      holders: [
        holder({
          units: 5,
          bytes: 1.5 * GB,
          reserveBytes: 5 * GB,
          reserveBasis: "measured",
        }),
        holder({
          work: "test",
          units: 1,
          bytes: 0.5 * GB,
          reserveBytes: 2 * GB,
          reserveBasis: "measured",
        }),
      ],
    });
    const c = fleetCharge(r);
    expect(c.bytes).toBeCloseTo(7 * GB);
    expect(c.headroomBytes).toBeCloseTo(5 * GB);
    // 68.72 − 5 − 40 = 23.72 left, 7 charged → 4 more quanta beside the 6 held: B caps at 9.
    expect(fleetWindow(r, BOX).slots).toBe(9);
    // The same reading charged a quantum per slot leaves 23.72 − 21.6: no slot more.
    expect(fleetWindow({ ...r, holders: [] }, BOX).slots).toBe(6);
  });

  test("a holder grown past its reservation is charged its measurement", () => {
    const r = reading({
      heldUnits: 2,
      opsBytes: 9 * GB,
      holders: [
        holder({
          units: 2,
          bytes: 8 * GB,
          reserveBytes: 3 * GB,
          reserveBasis: "measured",
        }),
      ],
    });
    // 8 for the holder, plus 1 GB of ops outside it (a script, a waiter).
    expect(fleetCharge(r).bytes).toBeCloseTo(9 * GB);
  });

  test("never below what the ops measure", () => {
    const r = reading({
      heldUnits: 1,
      opsBytes: 6 * GB,
      holders: [
        holder({
          bytes: 1 * GB,
          reserveBytes: 0.5 * GB,
          reserveBasis: "measured",
        }),
      ],
    });
    expect(fleetCharge(r).bytes).toBeGreaterThanOrEqual(6 * GB);
  });

  test("slots held without a marker (an older CLI) are charged a quantum each", () => {
    const r = reading({
      heldUnits: 3,
      opsBytes: 2 * GB,
      holders: [
        holder({
          bytes: 1 * GB,
          reserveBytes: 1 * GB,
          reserveBasis: "measured",
        }),
      ],
    });
    const c = fleetCharge(r);
    expect(c.unrecordedUnits).toBe(2);
    expect(c.bytes).toBeCloseTo(1 * GB + 2 * PER_UNIT_BYTES);
  });
});

describe("holderReserve", () => {
  test("too few records: the whole quantum per unit", () => {
    expect(holderReserve(3, [1 * GB, 2 * GB])).toEqual({
      bytes: 3 * PER_UNIT_BYTES,
      basis: "unmeasured",
      samples: 0,
    });
  });

  test("10–19 records: the largest peak recorded", () => {
    const peaks = [3, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1].map((g) => g * GB);
    expect(holderReserve(1, peaks).bytes).toBe(3 * GB);
  });

  test("a work that changes shape lifts its reservation from its latest holders", () => {
    // 40 light holders, then one heavy: the p95 is still light, the recent max is not.
    const peaks = [...Array.from({ length: 40 }, () => 1 * GB), 6 * GB];
    expect(holderReserve(1, peaks).bytes).toBe(6 * GB);
  });

  test("enough records: their 95th percentile, whatever the units", () => {
    // Newest are the smallest, so the quantile decides, not the recent max.
    const peaks = Array.from({ length: 20 }, (_, i) => (20 - i) * GB);
    const r = holderReserve(1, peaks);
    expect(r.basis).toBe("measured");
    expect(r.bytes).toBe(19 * GB);
    expect(holderReserve(6, peaks).bytes).toBe(19 * GB);
  });

  test("only the window's records count", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const rec = (daysAgo: number, peakBytes: number) => ({
      t: new Date(now - daysAgo * 86_400_000).toISOString(),
      work: "test" as const,
      units: 1,
      lane: "background" as const,
      peakBytes,
      samples: 2,
      seenMs: 30_000,
    });
    const byWork = peaksByWork([rec(1, 1 * GB), rec(20, 9 * GB)], now);
    expect(byWork.get("test")).toEqual([1 * GB]);
  });
});

describe("laneCapacity", () => {
  test("interactive gets the window, background its share below the reserved floor", () => {
    expect(laneCapacity(9, "interactive", BOX)).toBe(9);
    expect(laneCapacity(9, "background", BOX)).toBe(6);
    expect(laneCapacity(3, "background", BOX)).toBe(2);
    expect(laneCapacity(2, "background", BOX)).toBe(1);
  });

  // A human-blocked op (main's recovery build) never queues behind an agent
  // build when memory has room for one op: that one is the interactive lane's.
  test("a one-slot window is the interactive lane's alone", () => {
    expect(laneCapacity(1, "interactive", BOX)).toBe(1);
    expect(laneCapacity(1, "background", BOX)).toBe(0);
  });

  test("every window keeps at least one slot background cannot take", () => {
    for (let w = 1; w <= 9; w++)
      expect(laneCapacity(w, "background", BOX)).toBeLessThan(
        laneCapacity(w, "interactive", BOX),
      );
  });

  test("a host whose whole pool is one slot shares it: nothing to partition", () => {
    const small: HostFacts = { cpus: 2, ramBytes: 8e9 };
    expect(laneCapacity(1, "background", small)).toBe(1);
  });
});

describe("fleetAdmission", () => {
  test("a reading inside its lease is measured, and says when the lease ends", () => {
    const a = fleetAdmission(reading({ sampledAt: 1_000 }), 31_000, BOX);
    expect(a.kind).toBe("measured");
    if (a.kind !== "measured") return;
    expect(a.window.slots).toBe(9);
    expect(a.expiresAtMs).toBe(1_000 + FLEET_MEMORY_LEASE_MS);
  });

  // Not the static ceiling: B alone is what let the host swap.
  test("no reading, or one past its lease: the two-slot floor, not B", () => {
    expect(fleetAdmission(null, 0, BOX)).toEqual({
      kind: "unmeasured",
      cause: "absent",
      ageMs: null,
      sampledAt: null,
      slots: 2,
    });
    const stale = fleetAdmission(
      reading({ sampledAt: 0 }),
      FLEET_MEMORY_LEASE_MS + 1,
      BOX,
    );
    expect(stale).toEqual({
      kind: "unmeasured",
      cause: "stale",
      ageMs: FLEET_MEMORY_LEASE_MS + 1,
      sampledAt: 0,
      slots: 2,
    });
  });

  test("the floor keeps one background slot and one reserved interactive slot", () => {
    const w = unmeasuredWindow(BOX);
    expect(laneCapacity(w, "background", BOX)).toBe(1);
    expect(laneCapacity(w, "interactive", BOX)).toBe(2);
    // A host whose whole fleet is one slot cannot split it.
    expect(unmeasuredWindow({ cpus: 2, ramBytes: 8e9 })).toBe(1);
  });
});
