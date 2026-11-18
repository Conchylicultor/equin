import { describe, expect, test } from "bun:test";
import {
  applyOpEvent,
  foldOpLines,
  liveTimes,
  orphanedOps,
  reconcilerCompletedEvent,
  toOpRecord,
} from "./internal/fold";
import {
  BEHIND_LONE_BUILD_REASON,
  WAIT_KINDS,
  type OpEvent,
  type OpFoldState,
  type OpSummary,
  type SleepStamp,
} from "./internal/types";

// The v2 change-only event stream through the one reducer. `now` is injected
// everywhere, so every live number is pinned against a fixed clock.

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

type Body = OpEvent extends infer E
  ? E extends OpEvent
    ? Omit<E, "v" | "opId" | "seq" | "at" | "t">
    : never
  : never;

/**
 * A v2 event for `op-1`, `offset` ms after the request — on both clocks unless
 * `over` makes them diverge (`at` = the wall offset, `t` = the monotonic one,
 * which pauses while the machine sleeps) or stamps the sleep clock.
 */
const ev = (
  seq: number,
  offset: number,
  body: Body,
  opId = "op-1",
  over: { at?: number; t?: number; sleep?: SleepStamp } = {},
): OpEvent =>
  ({
    v: 2,
    opId,
    seq,
    at: at(over.at ?? offset),
    t: over.t ?? offset,
    ...(over.sleep ? { sleep: over.sleep } : {}),
    ...body,
  }) as OpEvent;

const requested = (opId = "op-1"): OpEvent =>
  ev(
    1,
    0,
    {
      e: "requested",
      kind: "build",
      opSlug: "wt-a",
      branch: "feature",
      conversationId: "conv-1",
      lane: "background",
      mode: null,
      buildId: "b-1",
      pid: 4242,
    },
    opId,
  );

const summary = (over: Partial<OpSummary> = {}): OpSummary => ({
  kind: "build",
  opSlug: "wt-a",
  branch: "feature",
  conversationId: "conv-1",
  lane: "background",
  mode: null,
  buildId: "b-1",
  pid: 4242,
  requestedAt: at(0),
  grantedAt: at(1_000),
  completedAt: at(100_000),
  waits: [
    {
      kind: "build-lock",
      startMs: 0,
      durationMs: 1_000,
      reason: null,
      cycle: 0,
      result: "acquired",
    },
  ],
  holdMs: 99_000,
  totalMs: 100_000,
  outcome: "success",
  interrupted: false,
  steps: [{ name: "vite", startMs: 10_000, durationMs: 50_000 }],
  ...over,
});

const stateOf = (lines: OpEvent[]): OpFoldState =>
  foldOpLines(lines).get("op-1")!;

/** A build parked in the duress valve on its second requeue cycle. */
const parkedBuild: OpEvent[] = [
  requested(),
  ev(2, 0, { e: "wait-start", wait: "build-lock", reason: null, cycle: 0 }),
  ev(3, 1_000, {
    e: "wait-end",
    wait: "build-lock",
    startMs: 0,
    durationMs: 1_000,
    result: "acquired",
    reason: null,
    cycle: 0,
  }),
  ev(4, 1_000, { e: "granted" }),
  ev(5, 60_000, {
    e: "wait-start",
    wait: "duress-valve",
    reason: "loadRatio",
    cycle: 0,
  }),
  ev(6, 90_000, {
    e: "wait-end",
    wait: "duress-valve",
    startMs: 60_000,
    durationMs: 30_000,
    result: "cleared",
    reason: "loadRatio",
    cycle: 0,
  }),
  ev(7, 90_000, {
    e: "wait-start",
    wait: "host-grant",
    reason: null,
    cycle: 0,
  }),
  ev(8, 120_000, {
    e: "wait-end",
    wait: "host-grant",
    startMs: 90_000,
    durationMs: 30_000,
    result: "acquired",
    reason: null,
    cycle: 0,
  }),
  ev(9, 120_000, { e: "requeue", cycle: 1, cause: "duress" }),
  ev(10, 120_000, {
    e: "wait-start",
    wait: "duress-valve",
    reason: "loadRatio",
    cycle: 1,
  }),
];

describe("v2 — in flight", () => {
  test("a parked build: open wait, reason, cycle, closed waits kept", () => {
    const s = stateOf(parkedBuild);
    expect(s.cycle).toBe(1);
    expect(s.lastSeq).toBe(10);
    expect(s.openWait).toEqual({
      kind: "duress-valve",
      startMs: 120_000,
      startedAt: at(120_000),
      reason: "loadRatio",
      cycle: 1,
    });
    expect(s.waits.map((w) => [w.kind, w.result, w.cycle])).toEqual([
      ["build-lock", "acquired", 0],
      ["duress-valve", "cleared", 0],
      ["host-grant", "acquired", 0],
    ]);

    const rec = toOpRecord(s, T0 + 180_000, null)!;
    expect(rec.outcome).toBe("running");
    expect(rec.pid).toBe(4242);
    expect(rec.cycle).toBe(1);
    expect(rec.openWait?.reason).toBe("loadRatio");
    // The open wait is clocked into the list for the Gantt.
    expect(rec.waits.at(-1)).toEqual({
      kind: "duress-valve",
      startMs: 120_000,
      durationMs: 60_000,
      reason: "loadRatio",
      cycle: 1,
      result: null,
      atMs: 120_000,
      wallMs: 60_000,
    });
    expect(rec.waitMs).toBe(1_000 + 30_000 + 30_000 + 60_000);
    expect(rec.holdMs).toBe(179_000);
    expect(rec.totalMs).toBe(180_000);
  });

  test("before `granted` the op is waiting", () => {
    const rec = toOpRecord(stateOf(parkedBuild.slice(0, 2)), T0 + 5_000, null)!;
    expect(rec.outcome).toBe("waiting");
    expect(rec.grantedAt).toBe(rec.requestedAt);
    expect(rec.holdMs).toBe(0);
    expect(rec.openWait?.kind).toBe("build-lock");
  });

  test("a fail-open valve wait records its result", () => {
    const s = stateOf([
      requested(),
      ev(2, 0, {
        e: "wait-start",
        wait: "duress-valve",
        reason: "memory",
        cycle: 0,
      }),
      ev(3, 1_800_000, {
        e: "wait-end",
        wait: "duress-valve",
        startMs: 0,
        durationMs: 1_800_000,
        result: "fail-open",
        reason: "memory",
        cycle: 0,
      }),
    ]);
    expect(s.openWait).toBeNull();
    expect(s.waits[0]?.result).toBe("fail-open");
    expect(s.waits[0]?.reason).toBe("memory");
  });

  test("a fast-path grant's lone wait-end is self-contained", () => {
    const s = stateOf([
      requested(),
      ev(2, 5_000, {
        e: "wait-end",
        wait: "host-grant",
        startMs: 4_000,
        durationMs: 1_000,
        result: "acquired",
        reason: null,
        cycle: 0,
      }),
    ]);
    expect(s.waits).toHaveLength(1);
    expect(s.waits[0]?.startMs).toBe(4_000);
    expect(s.openWait).toBeNull();
  });

  test("a wait-start over an open wait closes the old one as aborted", () => {
    const s = stateOf([
      requested(),
      ev(2, 0, { e: "wait-start", wait: "build-lock", reason: null, cycle: 0 }),
      ev(3, 3_000, {
        e: "wait-start",
        wait: "host-grant",
        reason: null,
        cycle: 0,
      }),
    ]);
    expect(s.waits).toEqual([
      {
        kind: "build-lock",
        startMs: 0,
        durationMs: 3_000,
        reason: null,
        cycle: 0,
        result: "aborted",
        atMs: 0,
        wallMs: 3_000,
      },
    ]);
    expect(s.openWait?.kind).toBe("host-grant");
  });
});

describe("v2 — seq idempotency", () => {
  test("re-applying the same lines changes nothing", () => {
    const once = stateOf(parkedBuild);
    let again = once;
    for (const line of parkedBuild) again = applyOpEvent(again, line);
    expect(again).toEqual(once);
  });

  test("a replayed earlier event is ignored (seq <= lastSeq)", () => {
    const s = stateOf(parkedBuild);
    const replay = applyOpEvent(s, parkedBuild[2]!); // the build-lock wait-end
    expect(replay).toBe(s);
    expect(replay.waits).toHaveLength(3);
  });

  test("applyOpEvent never mutates its input", () => {
    const s = stateOf(parkedBuild.slice(0, 4));
    const snapshot = structuredClone(s);
    applyOpEvent(s, parkedBuild[4]!);
    expect(s).toEqual(snapshot);
  });
});

describe("v2 — terminal", () => {
  const completed = ev(20, 100_000, {
    e: "completed",
    by: "self",
    summary: summary(),
  });

  test("the summary overwrites the state and freezes the numbers", () => {
    const s = stateOf([...parkedBuild, completed]);
    expect(s.closedBy).toBe("self");
    expect(s.openWait).toBeNull();
    const rec = toOpRecord(s, T0 + 999_999, null)!;
    expect(rec.outcome).toBe("success");
    expect(rec.totalMs).toBe(100_000);
    expect(rec.holdMs).toBe(99_000);
    expect(rec.waits).toEqual(summary().waits);
    expect(rec.steps).toHaveLength(1);
    expect(rec.openWait).toBeNull();
    expect(rec.closedBy).toBe("self");
  });

  test("terminal wins: every event after it is ignored", () => {
    const s = stateOf([
      ...parkedBuild,
      completed,
      ev(21, 200_000, {
        e: "wait-start",
        wait: "host-grant",
        reason: null,
        cycle: 3,
      }),
      ev(22, 200_000, {
        e: "completed",
        by: "reconciler",
        summary: summary({ interrupted: true, outcome: "error" }),
      }),
    ]);
    expect(s.closedBy).toBe("self");
    expect(s.outcome).toBe("success");
    expect(s.openWait).toBeNull();
  });

  test("a terminal applies even with a seq below lastSeq", () => {
    const s = stateOf([
      ...parkedBuild,
      ev(1, 100_000, { e: "completed", by: "self", summary: summary() }),
    ]);
    expect(s.closedBy).toBe("self");
  });

  test("a headless op (requested clipped away) renders nothing until its terminal", () => {
    const tail = parkedBuild.slice(4); // no `requested`
    expect(toOpRecord(stateOf(tail), T0 + 200_000, null)).toBeNull();
    // The self-contained terminal alone is a full record.
    const rec = toOpRecord(stateOf([...tail, completed]), T0, null)!;
    expect(rec.kind).toBe("build");
    expect(rec.opSlug).toBe("wt-a");
    expect(rec.buildId).toBe("b-1");
    expect(rec.requestedAt).toBe(at(0));
    expect(rec.steps).toHaveLength(1);
  });
});

describe("liveTimes", () => {
  test("in flight: waited = closed + open, worked = the rest", () => {
    const t = liveTimes(stateOf(parkedBuild), T0 + 180_000, null);
    expect(t).toEqual({
      elapsedMs: 180_000,
      openWaitMs: 60_000,
      waitingMs: 1_000 + 30_000 + 30_000 + 60_000,
      workingMs: 180_000 - 121_000,
      asleepMs: 0,
    });
  });

  test("terminal: from the summary, independent of now", () => {
    const s = stateOf([
      requested(),
      ev(2, 100_000, { e: "completed", by: "self", summary: summary() }),
    ]);
    expect(liveTimes(s, T0 + 999_999, null)).toEqual({
      elapsedMs: 100_000,
      waitingMs: 1_000,
      workingMs: 99_000,
      asleepMs: 0,
      openWaitMs: 0,
    });
  });

  test("clock skew never yields a negative duration", () => {
    const t = liveTimes(stateOf(parkedBuild), T0 - 10_000, null);
    expect(t.elapsedMs).toBe(0);
    expect(t.openWaitMs).toBe(0);
    expect(t.workingMs).toBe(0);
  });
});

describe("reconciliation", () => {
  test("orphanedOps: in-flight ops with identity only", () => {
    const states = foldOpLines([
      ...parkedBuild,
      requested("op-2"),
      ev(2, 1, { e: "completed", by: "self", summary: summary() }, "op-2"),
      ev(5, 1, { e: "granted" }, "headless"),
    ]);
    expect(orphanedOps(states.values()).map((s) => s.opId)).toEqual(["op-1"]);
  });

  test("the reconciler terminal closes the op as interrupted, keeping every wait", () => {
    const [orphan] = orphanedOps([stateOf(parkedBuild)]);
    const line = reconcilerCompletedEvent(orphan!, T0 + 300_000, null);
    expect(line.seq).toBe(11);
    const s = applyOpEvent(stateOf(parkedBuild), line);
    const rec = toOpRecord(s, T0 + 999_999, null)!;
    expect(rec.interrupted).toBe(true);
    expect(rec.outcome).toBe("error");
    expect(rec.closedBy).toBe("reconciler");
    expect(rec.totalMs).toBe(0);
    expect(rec.completedAt).toBeNull();
    // The open valve wait is kept, closed as aborted at the reconcile instant.
    expect(rec.waits).toHaveLength(4);
    const last = rec.waits.at(-1)!;
    expect(last.kind).toBe("duress-valve");
    expect(last.result).toBe("aborted");
    expect(last.startMs + last.durationMs).toBe(300_000);
    expect(rec.grantedAt).toBe(at(1_000));
  });
});

describe("WAIT_KINDS", () => {
  test("every wait kind has a label and a sentence", () => {
    for (const meta of Object.values(WAIT_KINDS)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.sentence(null).length).toBeGreaterThan(0);
    }
    expect(WAIT_KINDS["duress-valve"].sentence("loadRatio")).toBe(
      "held: host under duress (loadRatio)",
    );
  });

  test("waiting behind a build admitted alone does not claim the host is under duress", () => {
    const sentence = WAIT_KINDS["duress-valve"].sentence(
      BEHIND_LONE_BUILD_REASON,
    );
    expect(sentence).toBe(
      "held: waiting for an agent build that started alone under duress",
    );
    expect(sentence).not.toContain("host under duress");
  });
});

// ── sleep ────────────────────────────────────────────────────────────────────

describe("sleep", () => {
  const A = "boot-A";
  const HOUR = 3_600_000;
  /** Sleep stamp of boot A: `asleep` ms asleep in total, optional wake offset. */
  const zz = (asleep: number, wakeOffset?: number, boot = A): SleepStamp =>
    wakeOffset === undefined
      ? { boot, asleepMs: asleep }
      : { boot, asleepMs: asleep, wakeAtMs: T0 + wakeOffset };
  const SLEPT = HOUR - 10_000; // 3_590_000

  const req = (sleep?: SleepStamp): OpEvent =>
    sleep ? { ...requested(), sleep } : requested();
  const granted = (seq: number, wall: number, sleep?: SleepStamp): OpEvent =>
    ev(seq, wall, { e: "granted" }, "op-1", { sleep });
  /** A post-nap wait-start: wall `wall`, but `t` only `wall − SLEPT`. */
  const startAfterNap = (sleep: SleepStamp): OpEvent =>
    ev(
      3,
      HOUR + 10_000,
      { e: "wait-start", wait: "host-grant", reason: null, cycle: 0 },
      "op-1",
      { t: 20_000, sleep },
    );

  test("exact placement: wakeAtMs inside the gap ends the block there", () => {
    const s = stateOf([
      req(zz(1_000)),
      granted(2, 10_000, zz(1_000)),
      startAfterNap(zz(1_000 + SLEPT, HOUR)),
    ]);
    expect(s.sleeps).toEqual([
      { startMs: 10_000, durationMs: SLEPT, approx: false },
    ]);
    expect(s.sleepStamp).toEqual({
      boot: A,
      asleepMs: 1_000 + SLEPT,
      atMs: T0 + HOUR + 10_000,
    });
    const rec = toOpRecord(s, T0 + HOUR + 20_000, null)!;
    expect(rec.asleepMs).toBe(SLEPT);
    expect(rec.sleeps).toEqual(s.sleeps);
    // The open wait sits on the wall axis, after the nap.
    expect(rec.waits.at(-1)).toMatchObject({
      atMs: HOUR + 10_000,
      wallMs: 10_000,
    });
    expect(rec.waitMs).toBe(10_000);
    expect(liveTimes(s, T0 + HOUR + 20_000, null)).toEqual({
      elapsedMs: HOUR + 20_000,
      waitingMs: 10_000,
      workingMs: 20_000,
      asleepMs: SLEPT,
      openWaitMs: 10_000,
    });
  });

  test("fallback placement: no usable wake ⇒ end of the gap, approx", () => {
    for (const wake of [undefined, 5_000 /* before the gap */]) {
      const s = stateOf([
        req(zz(1_000)),
        granted(2, 10_000, zz(1_000)),
        startAfterNap(zz(1_000 + SLEPT, wake)),
      ]);
      expect(s.sleeps).toEqual([
        { startMs: 20_000, durationMs: SLEPT, approx: true },
      ]);
    }
  });

  test("more sleep than the gap holds is clamped to the gap, approx", () => {
    const s = stateOf([req(zz(0)), granted(2, 10_000, zz(5_000_000, 10_000))]);
    expect(s.sleeps).toEqual([
      { startMs: 0, durationMs: 10_000, approx: true },
    ]);
  });

  test("a boot change resets the stamp and invents no sleep", () => {
    const s = stateOf([
      req(zz(1_000)),
      granted(2, 10_000, zz(1_000)),
      startAfterNap(zz(50, undefined, "boot-B")),
    ]);
    expect(s.sleeps).toEqual([]);
    expect(s.sleepStamp?.boot).toBe("boot-B");
  });

  test("a line without a stamp leaves the last stamp untouched", () => {
    const s = stateOf([
      req(zz(1_000)),
      granted(2, 10_000), // an older writer / unsupported platform
      startAfterNap(zz(1_000 + SLEPT)),
    ]);
    // The gap runs from the LAST STAMP (the request), not the unstamped event.
    expect(s.sleeps).toEqual([
      { startMs: 20_000, durationMs: SLEPT, approx: true },
    ]);
  });

  test("a legacy op (no stamps at all) folds as before: no sleep", () => {
    const s = stateOf(parkedBuild);
    expect(s.sleeps).toEqual([]);
    expect(s.sleepStamp).toBeNull();
    const rec = toOpRecord(s, T0 + 180_000, null)!;
    expect(rec.sleeps).toEqual([]);
    expect(rec.asleepMs).toBe(0);
  });

  test("sleep inside a wait counts as asleep, never also as waiting", () => {
    const s = stateOf([
      req(zz(1_000)),
      ev(
        2,
        10_000,
        { e: "wait-start", wait: "push-mutex", reason: null, cycle: 0 },
        "op-1",
        { sleep: zz(1_000) },
      ),
      ev(
        3,
        HOUR + 10_000,
        {
          e: "wait-end",
          wait: "push-mutex",
          startMs: 10_000,
          durationMs: 10_000, // `t`: the nap is not in it
          result: "acquired",
          reason: null,
          cycle: 0,
        },
        "op-1",
        { t: 20_000, sleep: zz(1_000 + SLEPT, HOUR) },
      ),
      granted(4, HOUR + 10_000, zz(1_000 + SLEPT, HOUR)),
    ]);
    expect(s.waits[0]).toMatchObject({ atMs: 10_000, wallMs: HOUR });
    const t = liveTimes(s, T0 + HOUR + 30_000, null);
    expect(t).toEqual({
      elapsedMs: HOUR + 30_000,
      waitingMs: 10_000, // wall extent HOUR − the nap
      workingMs: 30_000,
      asleepMs: SLEPT,
      openWaitMs: 0,
    });
    expect(toOpRecord(s, T0 + HOUR + 30_000, null)!.waitMs).toBe(10_000);
  });

  describe("live tail", () => {
    // Stamped last at 10 s; the machine has slept since.
    const s = stateOf([req(zz(1_000)), granted(2, 10_000, zz(1_000))]);
    const now = T0 + HOUR + 20_000;

    test("no sleepNow: unknown, so no tail", () => {
      const t = liveTimes(s, now, null);
      expect(t.asleepMs).toBe(0);
      expect(t.workingMs).toBe(HOUR + 20_000);
    });

    test("sleepNow with a wake: exact tail ending at the wake", () => {
      const sleepNow = {
        boot: A,
        asleepMs: 1_000 + SLEPT,
        wakeAtMs: T0 + HOUR,
      };
      expect(toOpRecord(s, now, sleepNow)!.sleeps).toEqual([
        { startMs: 10_000, durationMs: SLEPT, approx: false },
      ]);
      expect(liveTimes(s, now, sleepNow)).toEqual({
        elapsedMs: HOUR + 20_000,
        waitingMs: 0,
        workingMs: 30_000,
        asleepMs: SLEPT,
        openWaitMs: 0,
      });
      // Derived on read, never stored.
      expect(s.sleeps).toEqual([]);
    });

    test("sleepNow without a wake: tail pinned to now, approx", () => {
      const sleepNow = { boot: A, asleepMs: 1_000 + SLEPT, wakeAtMs: null };
      expect(toOpRecord(s, now, sleepNow)!.sleeps).toEqual([
        { startMs: 30_000, durationMs: SLEPT, approx: true },
      ]);
    });

    test("sleepNow from another boot: no tail", () => {
      const sleepNow = { boot: "boot-B", asleepMs: 9e9, wakeAtMs: null };
      expect(liveTimes(s, now, sleepNow).asleepMs).toBe(0);
    });

    test("an open wait is clipped by the tail", () => {
      const parked = stateOf([
        req(zz(1_000)),
        ev(
          2,
          10_000,
          { e: "wait-start", wait: "host-grant", reason: null, cycle: 0 },
          "op-1",
          { sleep: zz(1_000) },
        ),
      ]);
      const sleepNow = {
        boot: A,
        asleepMs: 1_000 + SLEPT,
        wakeAtMs: T0 + HOUR,
      };
      const t = liveTimes(parked, now, sleepNow);
      expect(t.openWaitMs).toBe(HOUR + 10_000 - SLEPT);
      expect(t.waitingMs).toBe(HOUR + 10_000 - SLEPT);
      expect(t.asleepMs).toBe(SLEPT);
      expect(t.workingMs).toBe(10_000);
      const open = toOpRecord(parked, now, sleepNow)!.waits.at(-1)!;
      expect(open.durationMs).toBe(HOUR + 10_000 - SLEPT);
      expect(open.wallMs).toBe(HOUR + 10_000);
    });
  });

  test("re-ingesting stamped lines is a no-op", () => {
    const lines = [
      req(zz(1_000)),
      granted(2, 10_000, zz(1_000)),
      startAfterNap(zz(1_000 + SLEPT, HOUR)),
    ];
    const once = stateOf(lines);
    let again = once;
    for (const line of lines) again = applyOpEvent(again, line);
    expect(again).toEqual(once);
  });

  test("overlapping sleeps merge, approx if any part is", () => {
    // Two stamps whose blocks touch: [10 s, 20 s] exact, then [20 s, 30 s].
    const s = stateOf([
      req(zz(0)),
      granted(2, 10_000, zz(0)),
      ev(3, 20_000, { e: "requeue", cycle: 1, cause: "duress" }, "op-1", {
        sleep: zz(10_000, 20_000),
      }),
      ev(4, 30_000, { e: "requeue", cycle: 2, cause: "duress" }, "op-1", {
        sleep: zz(20_000),
      }),
    ]);
    expect(s.sleeps).toEqual([
      { startMs: 10_000, durationMs: 20_000, approx: true },
    ]);
  });

  describe("terminal", () => {
    const stamped = [
      req(zz(1_000)),
      granted(2, 10_000, zz(1_000)),
      startAfterNap(zz(1_000 + SLEPT, HOUR)),
    ];

    test("the summary's sleeps are authoritative", () => {
      const sleeps = [{ startMs: 5_000, durationMs: 1_000, approx: false }];
      const s = stateOf([
        ...stamped,
        ev(9, HOUR + 30_000, {
          e: "completed",
          by: "self",
          summary: summary({ totalMs: HOUR + 30_000, sleeps }),
        }),
      ]);
      expect(s.sleeps).toEqual(sleeps);
    });

    test("an older summary without sleeps keeps the fold's, closed by its stamp", () => {
      const s = stateOf([
        ...stamped,
        ev(
          9,
          2 * HOUR,
          {
            e: "completed",
            by: "self",
            summary: summary({ totalMs: 2 * HOUR, waits: [] }),
          },
          "op-1",
          { sleep: zz(1_000 + SLEPT + 60_000) },
        ),
      ]);
      expect(s.sleeps).toEqual([
        { startMs: 10_000, durationMs: SLEPT, approx: false },
        { startMs: 2 * HOUR - 60_000, durationMs: 60_000, approx: true },
      ]);
      const rec = toOpRecord(s, T0 + 9e9, null)!;
      expect(rec.asleepMs).toBe(SLEPT + 60_000);
      expect(rec.waitMs + rec.asleepMs).toBeLessThanOrEqual(rec.totalMs);
    });

    test("the reconciler's close carries its stamp and records the tail", () => {
      const s = stateOf(stamped);
      const [orphan] = orphanedOps([s]);
      const sleepNow = {
        boot: A,
        asleepMs: 1_000 + SLEPT + 600_000,
        wakeAtMs: T0 + 2 * HOUR,
      };
      const line = reconcilerCompletedEvent(
        orphan!,
        T0 + 2 * HOUR + 1_000,
        sleepNow,
      );
      expect(line.sleep).toEqual({
        boot: A,
        asleepMs: 1_000 + SLEPT + 600_000,
        wakeAtMs: T0 + 2 * HOUR,
      });
      if (line.e !== "completed") throw new Error("expected completed");
      expect(line.summary.sleeps).toEqual([
        { startMs: 10_000, durationMs: SLEPT, approx: false },
        { startMs: 2 * HOUR - 600_000, durationMs: 600_000, approx: false },
      ]);
      // The open wait closes with its wall extent.
      expect(line.summary.waits.at(-1)).toMatchObject({
        result: "aborted",
        atMs: HOUR + 10_000,
        wallMs: HOUR - 9_000,
      });
      const closed = applyOpEvent(s, line);
      expect(closed.sleeps).toEqual(line.summary.sleeps!);
      // No stamp to give (unsupported): no event stamp, the fold's sleeps kept.
      const blind = reconcilerCompletedEvent(orphan!, T0 + 2 * HOUR, null);
      expect(blind.sleep).toBeUndefined();
      if (blind.e !== "completed") throw new Error("expected completed");
      expect(blind.summary.sleeps).toEqual(s.sleeps);
    });
  });

  test("waiting + working + asleep === elapsed over random interleavings", () => {
    // A seeded PRNG (mulberry32): reproducible, no flake.
    let seed = 0x5eed;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number): number => Math.floor(rand() * n);
    const kinds = ["build-lock", "duress-valve", "host-grant"] as const;

    for (let run = 0; run < 300; run++) {
      let wall = 0;
      let t = 0;
      let asleep = int(10_000);
      let boot = A;
      let seq = 1;
      let open: { startT: number; kind: (typeof kinds)[number] } | null = null;
      const lines: OpEvent[] = [
        { ...requested(), sleep: zz(asleep, undefined, boot) },
      ];
      const steps = 2 + int(12);
      for (let i = 0; i < steps; i++) {
        const work = int(20_000);
        const nap = rand() < 0.4 ? int(HOUR) : 0;
        wall += work + nap;
        t += work;
        asleep += nap;
        if (rand() < 0.05) {
          boot = boot === A ? "boot-B" : A;
          asleep = int(1_000);
        }
        const wake = nap > 0 && rand() < 0.6 ? wall - int(work + 1) : undefined;
        const sleep = rand() < 0.15 ? undefined : zz(asleep, wake, boot); // some unstamped
        seq++;
        const over = { at: wall, t, sleep };
        if (open === null && rand() < 0.5) {
          const kind = kinds[int(kinds.length)]!;
          open = { startT: t, kind };
          lines.push(
            ev(
              seq,
              0,
              { e: "wait-start", wait: kind, reason: null, cycle: 0 },
              "op-1",
              over,
            ),
          );
        } else if (open !== null) {
          lines.push(
            ev(
              seq,
              0,
              {
                e: "wait-end",
                wait: open.kind,
                startMs: open.startT,
                durationMs: t - open.startT,
                result: "acquired",
                reason: null,
                cycle: 0,
              },
              "op-1",
              over,
            ),
          );
          open = null;
        } else {
          lines.push(ev(seq, 0, { e: "granted" }, "op-1", over));
        }
      }
      const s = stateOf(lines);
      const now = T0 + wall + int(2 * HOUR);
      const sleepNow =
        rand() < 0.3
          ? null
          : {
              boot,
              asleepMs: asleep + int(HOUR),
              wakeAtMs: rand() < 0.5 ? null : now - int(1_000),
            };
      const times = liveTimes(s, now, sleepNow);
      expect(times.waitingMs + times.workingMs + times.asleepMs).toBe(
        times.elapsedMs,
      );
      expect(times.waitingMs).toBeGreaterThanOrEqual(0);
      expect(times.asleepMs).toBeGreaterThanOrEqual(0);
      const rec = toOpRecord(s, now, sleepNow)!;
      expect(rec.waitMs).toBe(times.waitingMs);
      expect(rec.asleepMs).toBe(times.asleepMs);
      expect(rec.totalMs).toBe(times.elapsedMs);

      // …and once closed by a summary-less terminal at `now`.
      const closed = applyOpEvent(
        s,
        ev(
          seq + 1,
          0,
          {
            e: "completed",
            by: "self",
            summary: summary({ totalMs: now - T0, waits: s.waits }),
          },
          "op-1",
          { at: now - T0, t, sleep: zz(asleep, undefined, boot) },
        ),
      );
      const done = liveTimes(closed, now + 1, null);
      expect(done.waitingMs + done.workingMs + done.asleepMs).toBe(
        done.elapsedMs,
      );
    }
  });
});
