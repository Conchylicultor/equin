import { describe, expect, test } from "bun:test";
import {
  renderOutcomeBlock,
  renderStallLine,
  renderThreadBlock,
  verdictSection,
  type TranscriptOutcome,
} from "./transcript";
import type { ThreadSummary } from "./thread-watch";

// Pure: no check registry, no filesystem. The transcript's per-check block is a
// contract with whoever reads the file (a human, a grep), so its shape is pinned
// here rather than inferred from a full run.
function outcome(over: Partial<TranscriptOutcome>): TranscriptOutcome {
  return {
    checkId: "some:check",
    result: { ok: true },
    cached: false,
    sharedFrom: null,
    observations: [],
    ...over,
  };
}

describe("renderOutcomeBlock", () => {
  test("a pass is one line; a cached pass says so", () => {
    expect(renderOutcomeBlock(outcome({}))).toEqual(["• some:check ... ok"]);
    expect(renderOutcomeBlock(outcome({ cached: true }))).toEqual([
      "• some:check ... ok (cached)",
    ]);
  });

  test("a verdict adopted from another run names that run, pass or fail", () => {
    expect(
      renderOutcomeBlock(outcome({ cached: true, sharedFrom: "op-1" })),
    ).toEqual(["• some:check ... ok (shared with run op-1)"]);
    expect(
      renderOutcomeBlock(
        outcome({
          result: { ok: false, message: "boom" },
          sharedFrom: "op-1",
        }),
      ),
    ).toEqual(["• some:check ... FAIL (shared with run op-1)", "  boom"]);
  });

  test("observations are indented under the result line, of either stream", () => {
    expect(
      renderOutcomeBlock(
        outcome({
          observations: [
            { line: "maxRSS 1.2 GB", stream: "stdout" },
            { line: "two\nlines", stream: "stderr" },
          ],
        }),
      ),
    ).toEqual(["• some:check ... ok", "  maxRSS 1.2 GB", "  two\n  lines"]);
  });

  test("a failure carries its full message and hint, indented", () => {
    expect(
      renderOutcomeBlock(
        outcome({
          result: { ok: false, message: "bad\nworse", hint: "fix it" },
        }),
      ),
    ).toEqual(["• some:check ... FAIL", "  bad\n  worse", "  hint: fix it"]);
  });

  test("an inconclusive result leads with its first message line, and stays non-FAIL", () => {
    const lines = renderOutcomeBlock(
      outcome({
        result: {
          ok: false,
          inconclusive: true,
          message: "host too loaded\ndetail",
          hint: "retry",
        },
      }),
    );
    expect(lines).toEqual([
      "⚠ some:check ... inconclusive — host too loaded",
      "  host too loaded\n  detail",
      "  hint: retry",
    ]);
  });

  test("a huge message is NOT truncated — that is the console's job, not the file's", () => {
    const message = Array.from({ length: 500 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const [, body] = renderOutcomeBlock(
      outcome({ result: { ok: false, message } }),
    );
    expect(body?.split("\n")).toHaveLength(500);
    expect(body).toContain("line 499");
  });
});

// The thread block and the console line read a `ThreadSummary`, so they are
// pinned on a synthetic one: two stalls, a check and a shared helper.
function summary(over: Partial<ThreadSummary> = {}): ThreadSummary {
  const check = {
    owner: "check x",
    samples: 60,
    example: ["spin @ plugins/x/check/index.ts:3"],
    detail: [],
  };
  const helper = {
    owner: "shared helper @ plugins/y/core/h.ts",
    samples: 20,
    example: ["helper @ plugins/y/core/h.ts:9"],
    detail: [],
  };
  return {
    longestLateMs: 7_400,
    stallCount: 2,
    stalledMs: 9_100,
    samples: 100,
    rateHz: 10,
    selfMs: 12,
    owners: [
      { ...check, ms: 6_000 },
      { ...helper, ms: 2_000 },
    ],
    kinds: {
      "blocking-io": 45,
      process: 5,
      "module-load": 0,
      cpu: 30,
      native: 20,
    },
    cpu: { userMs: 800, systemMs: 100 },
    stallOwners: [check, helper],
    stalls: [
      {
        offsetMs: 1_200,
        durationMs: 7_450,
        lateMs: 7_400,
        running: ["x", "y"],
        bootstrap: [],
        samples: 60,
        owners: [check],
        kinds: {
          "blocking-io": 45,
          process: 0,
          "module-load": 0,
          cpu: 15,
          native: 0,
        },
        leaves: [{ leaf: "readdirSync [native]", samples: 45 }],
        cpu: { userMs: 700, systemMs: 90 },
      },
      {
        offsetMs: 9_000,
        durationMs: 1_750,
        lateMs: 1_700,
        running: ["y"],
        bootstrap: [],
        samples: 20,
        owners: [helper],
        kinds: {
          "blocking-io": 0,
          process: 5,
          "module-load": 0,
          cpu: 0,
          native: 15,
        },
        leaves: [{ leaf: "spawn [native]", samples: 5 }],
        cpu: { userMs: 100, systemMs: 10 },
      },
    ],
    ...over,
  };
}

describe("renderStallLine", () => {
  test("one line: longest stall, count, total, and who held the thread across the stalls", () => {
    expect(renderStallLine(summary(), "/tmp/check-r1.log")).toBe(
      "⚠ check thread stalled 7.4 s (longest of 2, 9.1 s total) — mostly " +
        "check x 75%, shared helper @ plugins/y/core/h.ts 25%. Details: /tmp/check-r1.log",
    );
  });

  test("nothing stalled → no line at all", () => {
    expect(
      renderStallLine(
        summary({ stallCount: 0, stalledMs: 0, stalls: [] }),
        null,
      ),
    ).toBeNull();
  });
});

describe("renderThreadBlock", () => {
  test("summary line, whole-run table with ms, then each stall with its running set and stacks", () => {
    expect(renderThreadBlock(summary())).toEqual([
      "thread: 2 stalls, 9.1 s stalled (longest 7.4 s); longest late tick 7400ms; 100 samples at 10 Hz; watch cost 12ms",
      "  who used the thread (whole run):",
      "     60%  ~6.0 s  check x",
      "     20%  ~2.0 s  shared helper @ plugins/y/core/h.ts",
      "  stall 1 at +1.2 s: 7.4 s, 60 samples, 2 checks in flight",
      "    waiting on: blocking I/O 75%, CPU 25%",
      "    on CPU: 0.7 s user + 0.1 s system (11% of 7.4 s stalled)",
      "    running: x, y",
      "    100%  check x",
      "          spin @ plugins/x/check/index.ts:3",
      "  stall 2 at +9.0 s: 1.7 s, 20 samples, 1 check in flight",
      "    waiting on: native 75%, process start 25%",
      "    on CPU: 0.1 s user + 0.0 s system (6% of 1.7 s stalled)",
      "    running: y",
      "    100%  shared helper @ plugins/y/core/h.ts",
      "          helper @ plugins/y/core/h.ts:9",
    ]);
  });

  test("with no stall there is no rate, so the table is shares only", () => {
    const lines = renderThreadBlock(
      summary({
        stallCount: 0,
        stalledMs: 0,
        rateHz: null,
        longestLateMs: 300,
        stalls: [],
        owners: [
          {
            owner: "import",
            samples: 100,
            example: [],
            detail: [{ name: "apps/mail", samples: 40 }],
            ms: null,
          },
        ],
      }),
    );
    expect(lines).toEqual([
      "thread: no stall; longest late tick 300ms; 100 samples; watch cost 12ms",
      "  who used the thread (whole run):",
      "    100%  import",
      "          of which: apps/mail 40%",
    ]);
  });
});

describe("verdictSection", () => {
  // The shape `openCheckTranscript` writes: header, outcomes, trailer, thread
  // block, done line.
  const header = [
    "check run r1",
    "  worktree: wt",
    "  pid:      1",
    "  scope:    all",
    "  checks:   a, b",
    "  started:  2026-10-11T00:00:00.000Z",
    "",
  ];
  const thread = [
    "",
    "thread: no stall; longest late tick 1ms; 3 samples; watch cost 1ms",
    "  who used the thread (whole run):",
    "    100%  shared run @ x.ts",
  ];

  test("keeps the outcomes, the trailer and the done line; drops header and thread block", () => {
    const lines = [
      ...header,
      "• a ... ok",
      "• b ... FAIL",
      "  boom",
      "\nIf you cannot fix the failing check(s): STOP",
      ...thread,
      "",
      "done — FAILED in 12ms",
    ];
    expect(verdictSection(lines)).toEqual([
      "• a ... ok",
      "• b ... FAIL",
      "  boom",
      "\nIf you cannot fix the failing check(s): STOP",
      "",
      "done — FAILED in 12ms",
    ]);
  });

  test("an unfinished transcript (no thread block yet) is its outcomes so far", () => {
    expect(verdictSection([...header, "• a ... ok"])).toEqual(["• a ... ok"]);
  });
});
