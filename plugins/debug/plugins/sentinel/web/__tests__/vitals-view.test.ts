/**
 * The Machine watcher row's stats view model: tones at two-thirds of a limit and
 * at it, a missing reading, staleness by age and by a reading from the wrong
 * watcher, and the trip banner's wording.
 */

import { describe, expect, it } from "vitest";
import type {
  SentinelVitalsRecord,
  SignalKey,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import { toneOf, vitalsView } from "../internal/vitals-view";

const WALL = new Date(2026, 8, 17, 18, 10).getTime();
const GIB = 1024 ** 3;

function vitals(
  overrides: Partial<SentinelVitalsRecord> = {},
): SentinelVitalsRecord {
  return {
    pid: 42,
    wall: WALL,
    cadenceMs: 5_000,
    signals: {
      loadRatio: { value: 0.26, limit: 1.5 },
      decompressionsPerSec: { value: 18_400, limit: 50_000 },
      locksWaiting: { value: 0, limit: 5 },
      blkReadDeltaMs: { value: 1_400, limit: 2_000 },
      slowBackends: { value: 0, limit: 2 },
    },
    elevated: [],
    tripped: false,
    context: {
      freeMemMb: 9_626,
      inFlightBuilds: 1,
      runningBackends: 11,
      disk: { totalBytes: 926 * GIB, freeBytes: 606 * GIB, fillBytesPerSec: 0 },
    },
    ...overrides,
  };
}

function line(view: ReturnType<typeof vitalsView>, key: SignalKey) {
  const found = view.signals.find((s) => s.key === key);
  if (!found) throw new Error(`no line for ${key}`);
  return found;
}

describe("toneOf", () => {
  it("is amber from two-thirds of the limit and red at it", () => {
    expect(toneOf(0.99, 1.5)).toBe("neutral");
    expect(toneOf(1.0, 1.5)).toBe("warn");
    expect(toneOf(1.49, 1.5)).toBe("warn");
    expect(toneOf(1.5, 1.5)).toBe("bad");
    expect(toneOf(null, 1.5)).toBe("neutral");
  });
});

describe("vitalsView", () => {
  it("writes each signal as 'X of LIMIT' in the mock's units, in the fixed order", () => {
    const view = vitalsView(vitals(), true, WALL + 3_000);
    expect(view.signals.map((s) => s.label)).toEqual([
      "Load per core",
      "Memory compression",
      "Waiting database locks",
      "Database disk reads",
      "Slow worktrees",
    ]);
    expect(line(view, "loadRatio")).toMatchObject({
      valueText: "0.26",
      limitText: "1.50",
      tone: "neutral",
    });
    expect(line(view, "decompressionsPerSec")).toMatchObject({
      valueText: "18k/s",
      limitText: "50k/s",
    });
    expect(line(view, "blkReadDeltaMs")).toMatchObject({
      valueText: "1.4 s",
      limitText: "2.0 s",
      tone: "warn",
    });
    expect(line(view, "loadRatio").fraction).toBeCloseTo(0.26 / 1.5);
    expect(view.stale).toBe(false);
    expect(view.banner).toBeNull();
    expect(view.footer).toBe("11 worktrees running · Updated 3s ago");
  });

  it("shows a missing reading as a dash with an empty bar", () => {
    const view = vitalsView(
      vitals({
        signals: {
          ...vitals().signals,
          locksWaiting: { value: null, limit: 5 },
        },
      }),
      true,
      WALL,
    );
    expect(line(view, "locksWaiting")).toMatchObject({
      valueText: "—",
      limitText: "5",
      fraction: 0,
      tone: "neutral",
    });
  });

  it("the glance gives load per core, memory and disk free, and builds", () => {
    const view = vitalsView(vitals(), true, WALL);
    expect(view.glance.map((f) => `${f.before}${f.value}${f.after}`)).toEqual([
      "Load 0.26 per core",
      "9.4 GB memory free",
      "606 GB disk free",
      "1 build",
    ]);
    const low = vitalsView(
      vitals({
        context: {
          freeMemMb: 400,
          inFlightBuilds: 6,
          runningBackends: 13,
          disk: {
            totalBytes: 926 * GIB,
            freeBytes: 40 * GIB,
            fillBytesPerSec: 0,
          },
        },
      }),
      true,
      WALL,
    );
    expect(low.glance.map((f) => f.tone)).toEqual([
      "neutral",
      "bad",
      "warn",
      "neutral",
    ]);
    expect(low.glance[3]?.after).toBe(" builds");
  });

  it("the disk figure says how fast a filling disk is falling", () => {
    const filling = vitalsView(
      vitals({
        context: {
          freeMemMb: 9_626,
          inFlightBuilds: 1,
          runningBackends: 11,
          disk: {
            totalBytes: 926 * GIB,
            freeBytes: 30 * GIB,
            fillBytesPerSec: (2 * GIB) / 60,
          },
        },
      }),
      true,
      WALL,
    );
    const disk = filling.glance.find((f) => f.key === "disk");
    expect(disk && `${disk.value}${disk.after}`).toBe(
      "30 GB disk free (−2.0 GB/min)",
    );
    expect(disk?.tone).toBe("bad");
    const unread = vitalsView(
      vitals({
        context: {
          freeMemMb: 9_626,
          inFlightBuilds: 1,
          runningBackends: 11,
          disk: null,
        },
      }),
      true,
      WALL,
    );
    expect(unread.glance.find((f) => f.key === "disk")?.value).toBe("— GB");
  });

  it("names what tripped the watcher", () => {
    const view = vitalsView(
      vitals({
        tripped: true,
        // Out of display order on purpose: the banner follows the lines' order.
        elevated: ["decompressionsPerSec", "loadRatio"],
      }),
      true,
      WALL,
    );
    expect(view.banner).toEqual({
      kind: "tripped",
      text: "Tripped by load and memory compression",
    });
    const three = vitalsView(
      vitals({
        tripped: true,
        elevated: ["slowBackends", "locksWaiting", "loadRatio"],
      }),
      true,
      WALL,
    );
    expect(three.banner?.text).toBe(
      "Tripped by load, waiting database locks and slow worktrees",
    );
  });

  it("is stale past three ticks without a new reading, and says how old", () => {
    expect(vitalsView(vitals(), true, WALL + 15_000).stale).toBe(false);
    const view = vitalsView(
      vitals({ tripped: true, elevated: ["loadRatio"] }),
      true,
      WALL + 120_000,
    );
    expect(view.stale).toBe(true);
    // A stale trip state is not claimed as live.
    expect(view.banner?.kind).toBe("stale");
    expect(view.banner?.text).toMatch(
      /^No new reading for 2 minutes\. These numbers are from .*10.*\.$/,
    );
    expect(view.footer).toBe("11 worktrees running · Updated 2m ago");
  });

  it("is stale when the reading is not from the watcher running now", () => {
    const view = vitalsView(vitals(), false, WALL + 1_000);
    expect(view.stale).toBe(true);
    expect(view.banner?.kind).toBe("stale");
    expect(view.banner?.text).toContain("not running now");
  });
});
