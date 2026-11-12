import { describe, expect, test } from "bun:test";
import type { OpRow } from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import {
  ceilTo,
  floorTo,
  groupOps,
  overlapping,
  recordsAt,
  spanOf,
  worktreeOf,
} from "./op-groups";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");

function row(over: Partial<OpRow> & { opId: string }): OpRow {
  return {
    kind: "build",
    opSlug: "att-a",
    branch: "claude-web/att-a",
    conversationId: null,
    lane: "interactive",
    mode: null,
    buildId: null,
    pid: 1,
    opportunistic: false,
    requestedAt: new Date(T0),
    grantedAt: new Date(T0),
    completedAt: new Date(T0 + 60_000),
    outcome: "success",
    interrupted: false,
    closedBy: "self",
    waits: [],
    openWait: null,
    cycle: 0,
    closedWaitMs: 0,
    holdMs: 60_000,
    totalMs: 60_000,
    steps: [],
    lastSeq: 5,
    sleeps: [],
    sleepStamp: null,
    ...over,
  };
}

describe("op-groups", () => {
  test("window bounds quantize to the step", () => {
    expect(floorTo(T0 + 123_456, 300_000)).toBe(T0);
    expect(ceilTo(T0 + 1, 300_000)).toBe(T0 + 300_000);
  });

  test("a slug-less legacy line files under its bare branch id", () => {
    expect(worktreeOf({ opSlug: null, branch: "claude-web/att-x" })).toBe(
      "att-x",
    );
    expect(worktreeOf({ opSlug: "att-y", branch: "claude-web/att-x" })).toBe(
      "att-y",
    );
  });

  test("an in-flight op's span and open wait grow with now", () => {
    const live = row({
      opId: "b",
      closedBy: null,
      completedAt: null,
      outcome: null,
      grantedAt: null,
      totalMs: 0,
      openWait: {
        kind: "duress-valve",
        startMs: 10_000,
        startedAt: new Date(T0 + 10_000).toISOString(),
        reason: "loadRatio",
        cycle: 2,
      },
    });
    const [rec] = recordsAt([live], T0 + 70_000, null);
    expect(rec?.totalMs).toBe(70_000);
    expect(rec?.outcome).toBe("waiting");
    expect(rec?.waits.at(-1)).toMatchObject({
      kind: "duress-valve",
      durationMs: 60_000,
      reason: "loadRatio",
      cycle: 2,
    });
  });

  test("an in-flight op's nap since its last event is asleep, not work, and reaches the Gantt entry", () => {
    const live = row({
      opId: "napper",
      closedBy: null,
      completedAt: null,
      outcome: null,
      totalMs: 0,
      // Last event at +60 s, with 5 s asleep since boot.
      sleepStamp: { boot: "boot-1", asleepMs: 5_000, atMs: T0 + 60_000 },
    });
    // Now +3 h; the box slept 2 h of it and woke 10 min ago.
    const now = T0 + 3 * 3_600_000;
    const sleepNow = {
      boot: "boot-1",
      asleepMs: 5_000 + 2 * 3_600_000,
      wakeAtMs: now - 600_000,
    };
    const [rec] = recordsAt([live], now, sleepNow);
    expect(rec?.asleepMs).toBe(2 * 3_600_000);
    expect(rec?.sleeps).toEqual([
      {
        startMs: now - 600_000 - 2 * 3_600_000 - T0,
        durationMs: 2 * 3_600_000,
        approx: false,
      },
    ]);
    // Unknown clock: no tail, as before.
    expect(recordsAt([live], now, null)[0]?.asleepMs).toBe(0);
    // A reading from another boot is never sleep.
    expect(
      recordsAt([live], now, { ...sleepNow, boot: "boot-2" })[0]?.asleepMs,
    ).toBe(0);

    const data = groupOps(rec ? [rec] : [], {});
    expect(data.groups[0]?.ops[0]?.sleeps).toEqual(rec?.sleeps);
  });

  test("a closed op carries its stored sleeps, whatever the reader's clock", () => {
    const sleeps = [{ startMs: 10_000, durationMs: 20_000, approx: true }];
    const [rec] = recordsAt([row({ opId: "slept", sleeps })], 0, {
      boot: "boot-1",
      asleepMs: 999_999_999,
      wakeAtMs: null,
    });
    expect(rec?.sleeps).toEqual(sleeps);
    expect(rec?.asleepMs).toBe(20_000);
  });

  test("groups per worktree, offsets from the earliest request, titles by slug", () => {
    const records = recordsAt(
      [
        row({
          opId: "late",
          opSlug: "att-b",
          requestedAt: new Date(T0 + 30_000),
        }),
        row({ opId: "early", conversationId: "conv-a" }),
      ],
      0,
      null,
    );
    const data = groupOps(records, { "att-a": "Fix the thing" });
    expect(data.totalMs).toBe(90_000);
    expect(
      data.groups.map((g) => [g.worktree, g.title, g.conversationId]),
    ).toEqual([
      ["att-a", "Fix the thing", "conv-a"],
      ["att-b", null, null],
    ]);
    expect(data.groups[1]?.ops[0]?.startMs).toBe(30_000);
  });

  test("span and overlap", () => {
    const records = recordsAt(
      [
        row({ opId: "a" }),
        row({ opId: "b", requestedAt: new Date(T0 + 600_000) }),
      ],
      0,
      null,
    );
    expect(spanOf(records)).toEqual({ startMs: T0, endMs: T0 + 660_000 });
    expect(spanOf([])).toBeNull();
    expect(
      overlapping(records, T0 + 30_000, T0 + 120_000).map((r) => r.opId),
    ).toEqual(["a"]);
  });
});
