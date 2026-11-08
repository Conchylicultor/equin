import { describe, expect, test } from "bun:test";
import { judgeSettleDeadline, judgeSettleStep } from "./stay-up";

const ME = 1_000;

describe("judgeSettleStep", () => {
  test("the process that took over reporting settled is deployed", () => {
    expect(
      judgeSettleStep(ME, { kind: "answer", startedAt: ME, boot: "settled" }),
    ).toEqual({ kind: "settled" });
  });

  test("still in its post-ready phases: wait", () => {
    expect(
      judgeSettleStep(ME, { kind: "answer", startedAt: ME, boot: "ready" }),
    ).toEqual({ kind: "waiting" });
  });

  test("a backend that does not report its boot is never read as settled", () => {
    expect(
      judgeSettleStep(ME, { kind: "answer", startedAt: ME, boot: undefined }),
    ).toEqual({ kind: "waiting" });
  });

  test("no answer is not yet evidence either way", () => {
    expect(
      judgeSettleStep(ME, { kind: "no-answer", detail: "HTTP 502" }),
    ).toEqual({ kind: "waiting" });
  });

  // The 2026-11-08 shape: ready, died ~5 s later, the next request respawned
  // it — the answer comes from another process, even a settled one.
  test("another process answering means the one that took over died", () => {
    expect(
      judgeSettleStep(ME, {
        kind: "answer",
        startedAt: ME + 10_000,
        boot: "settled",
      }),
    ).toEqual({ kind: "died", successorStartedAt: ME + 10_000 });
  });
});

describe("judgeSettleDeadline", () => {
  test("alive and answering but not settled is unproven, never up", () => {
    expect(
      judgeSettleDeadline(
        { kind: "answer", startedAt: ME, boot: "ready" },
        ME,
        "running",
      ).kind,
    ).toBe("unproven");
  });

  test.each(["idle", "broken", "starting"])(
    "silent with the gateway holding no live backend (%s) is a death",
    (state) => {
      expect(
        judgeSettleDeadline(
          { kind: "no-answer", detail: "HTTP 502" },
          ME,
          state,
        ).kind,
      ).toBe("died");
    },
  );

  test("silent while the gateway calls it running, or is unreachable: unproven", () => {
    const silent = { kind: "no-answer", detail: "timed out" } as const;
    expect(judgeSettleDeadline(silent, ME, "running").kind).toBe("unproven");
    expect(judgeSettleDeadline(silent, ME, null).kind).toBe("unproven");
  });
});
