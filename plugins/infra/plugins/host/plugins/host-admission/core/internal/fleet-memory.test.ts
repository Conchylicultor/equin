import { describe, expect, test } from "bun:test";
import { PER_UNIT_BYTES, type HostFacts } from "./budget";
import {
  fleetAdmission,
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

describe("laneCapacity", () => {
  test("interactive gets the window, background its share below the reserved floor", () => {
    expect(laneCapacity(9, "interactive")).toBe(9);
    expect(laneCapacity(9, "background")).toBe(6);
    expect(laneCapacity(3, "background")).toBe(2);
    // One slot is shared, as on a one-slot host.
    expect(laneCapacity(1, "background")).toBe(1);
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
    expect(laneCapacity(w, "background")).toBe(1);
    expect(laneCapacity(w, "interactive")).toBe(2);
    // A host whose whole fleet is one slot cannot split it.
    expect(unmeasuredWindow({ cpus: 2, ramBytes: 8e9 })).toBe(1);
  });
});
