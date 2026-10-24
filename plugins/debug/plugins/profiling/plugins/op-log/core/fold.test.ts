import { describe, expect, test } from "bun:test";
import { foldOpLines, sumWaits, toOpRecords } from "./internal/fold";
import type { OpRecord, OpWaitSpan, RawOpRecord } from "./internal/types";

// LEGACY snapshot lines (pre-v2 CLIs): these must keep folding exactly as they
// did before the v2 event format, until Phase 5 removes them. The v2 event
// stream is covered in fold-v2.test.ts.

const foldOpRecords = (raw: RawOpRecord[], now: number): OpRecord[] =>
  toOpRecords(foldOpLines(raw).values(), now, null);

/** A wait's geometry only — legacy lines carry no reason / cycle / result. */
const spans = (ws: readonly (OpWaitSpan | undefined)[]): OpWaitSpan[] =>
  ws.map((w) => ({
    kind: w!.kind,
    startMs: w!.startMs,
    durationMs: w!.durationMs,
  }));

// `now` is injected into every fold, so these tests pin the live-bar synthesis
// against a fixed clock rather than a real one.
const T0 = Date.parse("2026-07-17T10:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const requested = (over: Partial<RawOpRecord> = {}): RawOpRecord => ({
  phase: "requested",
  opId: "op-1",
  kind: "build",
  opSlug: "wt-a",
  branch: "feature",
  conversationId: "conv-1",
  lane: "background",
  buildId: "abc-123",
  requestedAt: at(0),
  waits: [],
  openWait: null,
  ...over,
});

describe("foldOpRecords — terminal wins", () => {
  test("a completed record wins over its own requested/granted lines", () => {
    const raw: RawOpRecord[] = [
      requested({
        openWait: { kind: "build-lock", startMs: 0, startedAt: at(0) },
      }),
      { phase: "granted", opId: "op-1", grantedAt: at(5_000), waits: [] },
      {
        ...requested(),
        phase: "completed",
        grantedAt: at(5_000),
        completedAt: at(65_000),
        waits: [{ kind: "build-lock", startMs: 0, durationMs: 5_000 }],
        holdMs: 60_000,
        totalMs: 65_000,
        outcome: "success",
        steps: [{ name: "checks", startMs: 0, durationMs: 30_000 }],
      },
    ];

    const [rec] = foldOpRecords(raw, T0 + 999_999);
    expect(rec).toBeDefined();
    // The terminal's frozen numbers, NOT a `now`-derived growing bar.
    expect(rec!.outcome).toBe("success");
    expect(rec!.totalMs).toBe(65_000);
    expect(rec!.holdMs).toBe(60_000);
    expect(rec!.completedAt).toBe(at(65_000));
    expect(rec!.waitMs).toBe(5_000);
    expect(rec!.steps).toHaveLength(1);
  });

  test("terminal wins regardless of line order (reconciler appends after the fact)", () => {
    const raw: RawOpRecord[] = [
      {
        ...requested(),
        phase: "completed",
        completedAt: null,
        outcome: "error",
        interrupted: true,
        holdMs: 0,
        totalMs: 0,
      },
      requested(), // a re-stamp that somehow landed later
    ];
    const [rec] = foldOpRecords(raw, T0 + 10_000);
    expect(rec!.interrupted).toBe(true);
    expect(rec!.outcome).toBe("error");
    expect(rec!.totalMs).toBe(0);
  });

  test("a terminal retains post-granted waits", () => {
    // The writer's `write()` emits its ACCUMULATED wait list (not `granted`'s
    // snapshot), so a wait that happened after admission must survive to the
    // frozen record.
    const raw: RawOpRecord[] = [
      requested(),
      {
        phase: "granted",
        opId: "op-1",
        grantedAt: at(1_000),
        waits: [{ kind: "build-lock", startMs: 0, durationMs: 1_000 }],
      },
      {
        ...requested(),
        phase: "completed",
        grantedAt: at(1_000),
        completedAt: at(400_000),
        waits: [
          { kind: "build-lock", startMs: 0, durationMs: 1_000 },
          { kind: "duress-valve", startMs: 60_000, durationMs: 30_000 },
          { kind: "host-grant", startMs: 90_000, durationMs: 240_000 },
        ],
        holdMs: 399_000,
        totalMs: 400_000,
        outcome: "success",
      },
    ];
    const [rec] = foldOpRecords(raw, T0 + 999_999);
    expect(rec!.waits).toHaveLength(3);
    expect(rec!.waitMs).toBe(271_000);
    expect(rec!.waits.map((w) => w.kind)).toEqual([
      "build-lock",
      "duress-valve",
      "host-grant",
    ]);
  });

  test("a terminal missing an up-front field falls back to the requested line", () => {
    const raw: RawOpRecord[] = [
      requested({ lane: "interactive", conversationId: "conv-9" }),
      {
        phase: "completed",
        opId: "op-1",
        kind: "build",
        branch: "feature",
        completedAt: at(1_000),
        outcome: "success",
        holdMs: 1_000,
        totalMs: 1_000,
      },
    ];
    const [rec] = foldOpRecords(raw, T0);
    expect(rec!.lane).toBe("interactive");
    expect(rec!.conversationId).toBe("conv-9");
  });
});

describe("foldOpRecords — waiting synth", () => {
  test("requested with an open wait grows against `now` and names the resource", () => {
    const raw = [
      requested({
        openWait: { kind: "host-grant", startMs: 0, startedAt: at(0) },
      }),
    ];

    const [rec] = foldOpRecords(raw, T0 + 30_000);
    expect(rec!.outcome).toBe("waiting");
    expect(spans(rec!.waits)).toEqual([
      { kind: "host-grant", startMs: 0, durationMs: 30_000 },
    ]);
    expect(rec!.waitMs).toBe(30_000);
    expect(rec!.holdMs).toBe(0);
    expect(rec!.totalMs).toBe(30_000);
    expect(rec!.completedAt).toBeNull();
  });

  test("the growing wait is the SECOND resource once the first has closed", () => {
    // The whole reason `requested` is re-stamped: a build parked in the duress
    // valve must not still render as blocked on the build lock.
    const raw = [
      requested({
        waits: [{ kind: "build-lock", startMs: 0, durationMs: 2_000 }],
        openWait: {
          kind: "duress-valve",
          startMs: 2_000,
          startedAt: at(2_000),
        },
      }),
    ];

    const [rec] = foldOpRecords(raw, T0 + 62_000);
    expect(rec!.outcome).toBe("waiting");
    expect(spans(rec!.waits)).toEqual([
      { kind: "build-lock", startMs: 0, durationMs: 2_000 },
      { kind: "duress-valve", startMs: 2_000, durationMs: 60_000 },
    ]);
    expect(rec!.waitMs).toBe(62_000);
  });

  test("requested with no open wait still renders, with a growing total", () => {
    const [rec] = foldOpRecords([requested()], T0 + 4_000);
    expect(rec!.outcome).toBe("waiting");
    expect(spans(rec!.waits)).toEqual([]);
    expect(rec!.waitMs).toBe(0);
    expect(rec!.totalMs).toBe(4_000);
  });

  test("identity survives the synth", () => {
    const [rec] = foldOpRecords([requested()], T0 + 1);
    expect(rec!.opSlug).toBe("wt-a");
    expect(rec!.buildId).toBe("abc-123");
    expect(rec!.lane).toBe("background");
    expect(rec!.kind).toBe("build");
  });
});

describe("foldOpRecords — running synth", () => {
  test("requested + granted: waits stay put while none is open, holdMs grows", () => {
    const grantWaits = [
      { kind: "build-lock" as const, startMs: 0, durationMs: 2_000 },
      { kind: "host-grant" as const, startMs: 3_000, durationMs: 7_000 },
    ];
    const raw: RawOpRecord[] = [
      requested({ waits: grantWaits }),
      {
        phase: "granted",
        opId: "op-1",
        grantedAt: at(10_000),
        waits: grantWaits,
      },
    ];

    const [rec] = foldOpRecords(raw, T0 + 70_000);
    expect(rec!.outcome).toBe("running");
    // Not now-derived: with no wait open, the list is whatever is on disk.
    expect(rec!.waitMs).toBe(9_000);
    expect(rec!.waits).toHaveLength(2);
    expect(rec!.holdMs).toBe(60_000); // 70_000 - 10_000, growing
    expect(rec!.totalMs).toBe(70_000);
    expect(rec!.grantedAt).toBe(at(10_000));
  });

  test("N host-grant waits across requeue cycles all survive", () => {
    const raw: RawOpRecord[] = [
      requested(),
      {
        phase: "granted",
        opId: "op-1",
        grantedAt: at(30_000),
        waits: [
          { kind: "duress-valve", startMs: 0, durationMs: 5_000 },
          { kind: "host-grant", startMs: 5_000, durationMs: 5_000 },
          { kind: "duress-valve", startMs: 10_000, durationMs: 10_000 },
          { kind: "host-grant", startMs: 20_000, durationMs: 10_000 },
        ],
      },
    ];
    const [rec] = foldOpRecords(raw, T0 + 30_000);
    expect(rec!.waits).toHaveLength(4);
    expect(rec!.waitMs).toBe(30_000);
  });

  // `markGranted()` = "stopped queuing for the ENTRY ticket, started working".
  // It does NOT mean "will never block again": push grants at the mutex then
  // queues for a nested host-grant; build grants at the build lock then hits the
  // valve + grant minutes later. For two of three kinds the most important wait
  // is POST-granted, so the list must keep growing after `granted`.
  test("a post-granted CLOSED wait (re-stamped requested) survives the fold", () => {
    const raw: RawOpRecord[] = [
      requested(),
      {
        phase: "granted",
        opId: "op-1",
        grantedAt: at(1_000),
        waits: [{ kind: "build-lock", startMs: 0, durationMs: 1_000 }],
      },
      // ...minutes of work, then a valve wait opened AND closed — re-stamped.
      requested({
        waits: [
          { kind: "build-lock", startMs: 0, durationMs: 1_000 },
          { kind: "duress-valve", startMs: 60_000, durationMs: 30_000 },
        ],
      }),
    ];
    const [rec] = foldOpRecords(raw, T0 + 100_000);
    expect(rec!.outcome).toBe("running");
    // The re-stamped `requested` is a superset of granted's snapshot and wins.
    expect(rec!.waits).toHaveLength(2);
    expect(spans([rec!.waits[1]])[0]).toEqual({
      kind: "duress-valve",
      startMs: 60_000,
      durationMs: 30_000,
    });
    expect(rec!.waitMs).toBe(31_000);
  });

  test("a post-granted OPEN wait grows against now, outcome stays running", () => {
    // The exact shape of a build parked in the host grant after admission — the
    // case that used to render as a motionless bar.
    const raw: RawOpRecord[] = [
      requested(),
      {
        phase: "granted",
        opId: "op-1",
        grantedAt: at(1_000),
        waits: [{ kind: "build-lock", startMs: 0, durationMs: 1_000 }],
      },
      requested({
        waits: [{ kind: "build-lock", startMs: 0, durationMs: 1_000 }],
        openWait: {
          kind: "host-grant",
          startMs: 60_000,
          startedAt: at(60_000),
        },
      }),
    ];

    const [rec] = foldOpRecords(raw, T0 + 360_000); // parked 5 min in the grant
    expect(rec!.outcome).toBe("running"); // NOT flipped back to "waiting"
    expect(spans(rec!.waits)).toEqual([
      { kind: "build-lock", startMs: 0, durationMs: 1_000 },
      { kind: "host-grant", startMs: 60_000, durationMs: 300_000 }, // growing
    ]);
    expect(rec!.waitMs).toBe(301_000);
    expect(rec!.holdMs).toBe(359_000); // still clocked from grantedAt

    // ...and it genuinely GROWS between two reads — the whole point.
    const [later] = foldOpRecords(raw, T0 + 420_000);
    expect(later!.waits[1]!.durationMs).toBe(360_000);
  });

  test("granted.waits is the fallback when requested was never re-stamped", () => {
    const raw: RawOpRecord[] = [
      {
        phase: "requested",
        opId: "op-1",
        kind: "build",
        branch: "b",
        requestedAt: at(0),
      },
      {
        phase: "granted",
        opId: "op-1",
        grantedAt: at(1_000),
        waits: [{ kind: "build-lock", startMs: 0, durationMs: 1_000 }],
      },
    ];
    const [rec] = foldOpRecords(raw, T0 + 2_000);
    expect(spans(rec!.waits)).toEqual([
      { kind: "build-lock", startMs: 0, durationMs: 1_000 },
    ]);
  });

  test("a stray granted with no requested carries no identity and is skipped", () => {
    const raw: RawOpRecord[] = [
      { phase: "granted", opId: "ghost", grantedAt: at(1) },
    ];
    expect(foldOpRecords(raw, T0)).toEqual([]);
  });
});

describe("foldOpRecords — interleaved concurrent writers", () => {
  test("three ops appending into one shared file fold independently", () => {
    // The real file shape: every CLI process appends to the same log, so lines
    // arrive interleaved. Grouping is by opId, never by adjacency.
    const push = (over: Partial<RawOpRecord>): RawOpRecord => ({
      phase: "requested",
      opId: "push-1",
      kind: "push",
      opSlug: "wt-b",
      branch: "b",
      requestedAt: at(0),
      ...over,
    });
    const check = (over: Partial<RawOpRecord>): RawOpRecord => ({
      phase: "requested",
      opId: "check-1",
      kind: "check",
      opSlug: "wt-c",
      branch: "c",
      requestedAt: at(0),
      ...over,
    });

    const raw: RawOpRecord[] = [
      requested({
        openWait: { kind: "build-lock", startMs: 0, startedAt: at(0) },
      }),
      push({ openWait: { kind: "push-mutex", startMs: 0, startedAt: at(0) } }),
      check({}),
      { phase: "granted", opId: "push-1", grantedAt: at(1_000), waits: [] },
      requested({
        openWait: { kind: "host-grant", startMs: 500, startedAt: at(500) },
      }),
      { phase: "granted", opId: "check-1", grantedAt: at(2_000), waits: [] },
      {
        ...push({}),
        phase: "completed",
        completedAt: at(9_000),
        outcome: "success",
        totalMs: 9_000,
        holdMs: 8_000,
      },
    ];

    const byId = new Map(
      foldOpRecords(raw, T0 + 10_000).map((r) => [r.opId, r]),
    );
    expect(byId.size).toBe(3);
    // push: terminal → frozen success
    expect(byId.get("push-1")!.outcome).toBe("success");
    expect(byId.get("push-1")!.totalMs).toBe(9_000);
    // check: requested + granted → running
    expect(byId.get("check-1")!.outcome).toBe("running");
    expect(byId.get("check-1")!.holdMs).toBe(8_000);
    // build: last requested re-stamp wins → waiting on host-grant
    expect(byId.get("op-1")!.outcome).toBe("waiting");
    expect(spans(byId.get("op-1")!.waits)).toEqual([
      { kind: "host-grant", startMs: 500, durationMs: 9_500 },
    ]);
  });
});

describe("partial final line", () => {
  // The reader's JSON.parse skips a torn final line before the fold ever sees
  // it; what the fold must guarantee is that the SURVIVING lines still produce
  // a coherent record — i.e. losing the terminal degrades to a live bar, never
  // to a crash or a dropped op.
  test("losing the terminal line degrades to a running bar, not a crash", () => {
    const raw: RawOpRecord[] = [
      requested(),
      { phase: "granted", opId: "op-1", grantedAt: at(1_000), waits: [] },
      // ...the `completed` line was torn mid-append and dropped by the reader.
    ];
    const [rec] = foldOpRecords(raw, T0 + 5_000);
    expect(rec!.outcome).toBe("running");
    expect(rec!.holdMs).toBe(4_000);
  });

  test("a record with nothing but phase+opId does not throw", () => {
    const raw: RawOpRecord[] = [{ phase: "requested", opId: "bare" }];
    const [rec] = foldOpRecords(raw, T0);
    expect(rec!.opId).toBe("bare");
    expect(rec!.branch).toBe("bare"); // falls back to the id, like the push reader
    expect(spans(rec!.waits)).toEqual([]);
    expect(rec!.outcome).toBe("waiting");
  });

  test("an unknown kind from a foreign/older writer is coerced, never cast through", () => {
    // Raw lines are untrusted input; a kind outside the closed set must not
    // reach OpRecord.kind, where the type would then be lying. Same guard
    // worktree-op.ts applies to its markers.
    const raw = [requested({ kind: "frobnicate" as never })];
    const [rec] = foldOpRecords(raw, T0);
    expect(rec!.kind).toBe("build");
  });

  test("an unparseable timestamp falls back instead of producing NaN", () => {
    const raw: RawOpRecord[] = [requested({ requestedAt: "not-a-date" })];
    const [rec] = foldOpRecords(raw, T0 + 1_000);
    expect(Number.isNaN(rec!.totalMs)).toBe(false);
    expect(rec!.totalMs).toBe(0);
  });
});

describe("a build-shaped sequence end-to-end", () => {
  // The real `build.ts` lifecycle, as raw lines: build-lock wait → granted →
  // minutes of migrations/codegen → duress-valve → host-grant → REQUEUE →
  // duress-valve → host-grant → completed. Every wait but the first is
  // POST-granted, which is the case the granted branch used to drop entirely.
  const buildWaits = [
    { kind: "build-lock" as const, startMs: 0, durationMs: 2_000 },
    // 60s gap of real work (migrations/codegen) — NOT packed head-to-tail.
    { kind: "duress-valve" as const, startMs: 62_000, durationMs: 30_000 },
    { kind: "host-grant" as const, startMs: 92_000, durationMs: 10_000 },
    // requeue cycle 2 — duress tripped while queued
    { kind: "duress-valve" as const, startMs: 102_000, durationMs: 20_000 },
    { kind: "host-grant" as const, startMs: 122_000, durationMs: 18_000 },
  ];

  const raw: RawOpRecord[] = [
    requested({
      openWait: { kind: "build-lock", startMs: 0, startedAt: at(0) },
    }),
    requested({ waits: [buildWaits[0]!] }),
    {
      phase: "granted",
      opId: "op-1",
      grantedAt: at(2_000),
      waits: [buildWaits[0]!],
    },
    requested({ waits: buildWaits.slice(0, 2) }),
    requested({ waits: buildWaits.slice(0, 3) }),
    requested({ waits: buildWaits.slice(0, 4) }),
    requested({ waits: buildWaits }),
    {
      ...requested({ waits: buildWaits }),
      phase: "completed",
      grantedAt: at(2_000),
      completedAt: at(200_000),
      holdMs: 198_000,
      totalMs: 200_000,
      outcome: "success",
      steps: [{ name: "vite", startMs: 138_000, durationMs: 60_000 }],
    },
  ];

  test("all 5 waits survive at their true offsets, not packed head-to-tail", () => {
    const [rec] = foldOpRecords(raw, T0 + 999_999);
    expect(rec!.outcome).toBe("success");
    expect(spans(rec!.waits)).toEqual(buildWaits);
    expect(rec!.waitMs).toBe(80_000);
    expect(rec!.totalMs).toBe(200_000);

    // Two distinct host-grant cycles — the un-merging of today's single span.
    expect(rec!.waits.filter((w) => w.kind === "host-grant")).toHaveLength(2);

    // Offsets are monotonic AND gapped by real work: the second wait starts at
    // 62_000, far past the first's end (2_000). Packing head-to-tail would put
    // it at 2_000 and hide the 60s of migrations/codegen.
    const starts = rec!.waits.map((w) => w.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(rec!.waits[1]!.startMs).toBeGreaterThan(
      rec!.waits[0]!.startMs + rec!.waits[0]!.durationMs,
    );

    // No wait segment may overflow the op's own span.
    for (const w of rec!.waits) {
      expect(w.startMs + w.durationMs).toBeLessThanOrEqual(rec!.totalMs);
    }
  });

  test("mid-flight, parked in the SECOND host-grant, the bar still grows", () => {
    // Truncate to the moment the last host-grant is open — i.e. what is on disk
    // while a build sits in the grant queue after admission.
    const midFlight: RawOpRecord[] = [
      ...raw.slice(0, 6),
      requested({
        waits: buildWaits.slice(0, 4),
        openWait: {
          kind: "host-grant",
          startMs: 122_000,
          startedAt: at(122_000),
        },
      }),
    ];
    const [rec] = foldOpRecords(midFlight, T0 + 422_000); // 5 min into the grant
    expect(rec!.outcome).toBe("running");
    expect(rec!.waits).toHaveLength(5);
    expect(spans([rec!.waits[4]])[0]).toEqual({
      kind: "host-grant",
      startMs: 122_000,
      durationMs: 300_000,
    });
    expect(rec!.waitMs).toBe(362_000);
  });
});

describe("foldOpRecords — steps", () => {
  // A standalone `./equin check`: one step per individual check, recorded
  // post-hoc through `OpProfiler.recordStep` (the mirror of `pushBuildSpan`)
  // from `checks/core`'s `onCheckDone`. `OpStep.startMs` is an offset from
  // `grantedAt` — NOT from `requestedAt` — so the wait that precedes the grant
  // must not shift the steps. That is the whole assertion below: a check queued
  // 20 s for its host grant still reports its first check at offset 0.
  const checkSteps = [
    { name: "migrations-in-sync", startMs: 0, durationMs: 1_200 },
    { name: "plugin-boundaries", startMs: 1_200, durationMs: 3_400 },
    { name: "eslint", startMs: 4_600, durationMs: 12_000 },
    { name: "type-check", startMs: 16_600, durationMs: 45_000 },
  ];

  const completedCheck = (): RawOpRecord => ({
    ...requested({ kind: "check", buildId: null, lane: "interactive" }),
    phase: "completed",
    // 20 s parked in the host-grant queue before any check ran.
    grantedAt: at(20_000),
    completedAt: at(81_600),
    waits: [{ kind: "host-grant", startMs: 0, durationMs: 20_000 }],
    holdMs: 61_600,
    totalMs: 81_600,
    outcome: "success",
    steps: checkSteps,
  });

  test("per-check steps survive the fold verbatim, offset from grantedAt", () => {
    const [rec] = foldOpRecords(
      [requested({ kind: "check" }), completedCheck()],
      T0 + 999_999,
    );
    expect(rec!.kind).toBe("check");
    expect(rec!.steps).toEqual(checkSteps);
    // The pre-grant wait does not displace the steps: the first check starts at
    // 0 on the grant clock even though the op was requested 20 s earlier. A
    // `requestedAt`-relative offset would read 20_000 here.
    expect(rec!.steps[0]!.startMs).toBe(0);
    // Steps are monotonic and fit inside the hold — they cannot spill into the
    // wait that preceded the grant.
    const last = rec!.steps.at(-1)!;
    expect(last.startMs + last.durationMs).toBeLessThanOrEqual(rec!.holdMs);
    for (let i = 1; i < rec!.steps.length; i++) {
      expect(rec!.steps[i]!.startMs).toBeGreaterThanOrEqual(
        rec!.steps[i - 1]!.startMs,
      );
    }
  });

  test("steps land even when the terminal is the ONLY line on disk", () => {
    // The reader must not depend on the `requested` re-stamp to see steps: they
    // are carried by the terminal alone.
    const [rec] = foldOpRecords([completedCheck()], T0 + 999_999);
    expect(rec!.steps).toEqual(checkSteps);
  });

  test("an in-flight op reports no steps — they only land on the terminal", () => {
    // `recordStep` accumulates in-process; nothing is on disk until `write()`.
    // A synthesized live bar must therefore claim none rather than a stale
    // subset.
    const [waiting] = foldOpRecords([requested({ kind: "check" })], T0 + 5_000);
    expect(waiting!.outcome).toBe("waiting");
    expect(waiting!.steps).toEqual([]);

    const [running] = foldOpRecords(
      [
        requested({ kind: "check" }),
        { phase: "granted", opId: "op-1", grantedAt: at(20_000), waits: [] },
      ],
      T0 + 30_000,
    );
    expect(running!.outcome).toBe("running");
    expect(running!.steps).toEqual([]);
  });

  test("a terminal written by an older CLI (no steps key) folds to an empty list", () => {
    const { steps: _dropped, ...noSteps } = completedCheck();
    const [rec] = foldOpRecords([noSteps], T0 + 999_999);
    expect(rec!.steps).toEqual([]);
  });
});

describe("sumWaits", () => {
  test("is the derived waitMs the stats panes read", () => {
    expect(sumWaits([])).toBe(0);
    expect(
      sumWaits([
        { kind: "build-lock", startMs: 0, durationMs: 100 },
        { kind: "host-grant", startMs: 200, durationMs: 50 },
      ]),
    ).toBe(150);
  });
});

describe("foldOpRecords — the op-kind vocabulary", () => {
  // The kind list is `OP_KINDS` in worktree/core; the fold must accept every
  // member as itself and fall back only for a kind it has never heard of.
  test("test and e2e records keep their kind, in flight and terminal", () => {
    const inFlight = foldOpRecords(
      [
        requested({ opId: "t-1", kind: "test" }),
        requested({ opId: "e-1", kind: "e2e" }),
      ],
      T0 + 1_000,
    );
    expect(inFlight.find((r) => r.opId === "t-1")?.kind).toBe("test");
    expect(inFlight.find((r) => r.opId === "e-1")?.kind).toBe("e2e");
    expect(inFlight.find((r) => r.opId === "t-1")?.outcome).toBe("waiting");

    const terminal = foldOpRecords(
      [
        requested({ opId: "t-2", kind: "test" }),
        { phase: "granted", opId: "t-2", grantedAt: at(500), waits: [] },
        {
          phase: "completed",
          opId: "t-2",
          kind: "test",
          requestedAt: at(0),
          grantedAt: at(500),
          completedAt: at(9_000),
          waits: [{ kind: "host-grant", startMs: 0, durationMs: 500 }],
          outcome: "failed",
        },
      ],
      T0 + 20_000,
    );
    expect(terminal[0]?.kind).toBe("test");
    expect(terminal[0]?.outcome).toBe("failed");
  });

  test("an unknown kind from an older or garbage writer falls back to build", () => {
    const out = foldOpRecords(
      [requested({ opId: "x", kind: "deploy" as unknown as "build" })],
      T0,
    );
    expect(out[0]?.kind).toBe("build");
  });
});

describe("legacy open wait — is the op parked right now?", () => {
  const hostGrant = {
    kind: "host-grant" as const,
    startMs: 500,
    startedAt: at(500),
  };
  const openWaitOf = (raw: RawOpRecord[]) =>
    foldOpLines(raw).get("op-1")!.openWait;

  test("the freshest requested stamp's open wait", () => {
    expect(
      openWaitOf([
        requested({
          openWait: { kind: "build-lock", startMs: 0, startedAt: at(0) },
        }),
        requested({ openWait: hostGrant }),
      ]),
    ).toEqual({ ...hostGrant, reason: null, cycle: 0 });
  });

  test("a closed wait re-stamps null: the op is working", () => {
    expect(
      openWaitOf([
        requested({ openWait: hostGrant }),
        requested({ openWait: null }),
      ]),
    ).toBeNull();
  });

  test("a terminal line closes every wait", () => {
    const [rec] = foldOpRecords(
      [
        requested({ openWait: hostGrant }),
        { phase: "completed", opId: "op-1", outcome: "error" },
      ],
      T0,
    );
    expect(rec!.openWait).toBeNull();
    expect(
      openWaitOf([
        requested({ openWait: hostGrant }),
        { phase: "completed", opId: "op-1", outcome: "error" },
      ]),
    ).toBeNull();
  });
});
