import { describe, expect, test } from "bun:test";
import { judgeFailingFile, type JudgedResult } from "./judge";

let t = 0;
// Results are listed OLDEST first here and reversed: the judge reads newest first.
function history(
  ...rows: Array<Partial<JudgedResult> & Pick<JudgedResult, "outcome">>
): JudgedResult[] {
  return rows
    .map((r) => ({
      opId: `op-${++t}`,
      digest: "old",
      ownCheckout: true,
      commit: `c${t}`,
      finishedAt: new Date(1_000_000 + t * 1000),
      ...r,
    }))
    .reverse();
}

describe("judgeFailingFile", () => {
  test("no result on the current code is quiet", () => {
    expect(judgeFailingFile("cur", history({ outcome: "passed" }))).toEqual({
      kind: "quiet",
      reason: "no-verdict-on-current-code",
    });
  });

  test("a first failure after a pass asks for a confirmation run", () => {
    const rs = history(
      { outcome: "passed" },
      { outcome: "failed", digest: "cur" },
    );
    expect(judgeFailingFile("cur", rs)).toEqual({ kind: "confirm" });
  });

  test("a confirmed failure after a pass reports, naming the first failing commit", () => {
    const rs = history(
      { outcome: "passed", commit: "pass1" },
      { outcome: "passed", commit: "pass2" },
      { outcome: "failed", digest: "mid", commit: "fail1" },
      { outcome: "failed", digest: "cur", commit: "fail2" },
      { outcome: "not-loaded", digest: "cur", commit: "fail3" },
    );
    const v = judgeFailingFile("cur", rs);
    expect(v.kind).toBe("report");
    if (v.kind !== "report") return;
    expect(v.lastPassed.commit).toBe("pass2");
    expect(v.firstFailed.commit).toBe("fail1");
    expect(v.latest.commit).toBe("fail3");
    expect(v.latest.outcome).toBe("not-loaded");
    expect(v.failuresOnCurrentCode).toBe(2);
  });

  test("a pass on the current code (flaky) is quiet", () => {
    const rs = history(
      { outcome: "passed" },
      { outcome: "failed", digest: "cur" },
      { outcome: "passed", digest: "cur" },
      { outcome: "failed", digest: "cur" },
    );
    expect(judgeFailingFile("cur", rs)).toEqual({
      kind: "quiet",
      reason: "passes-on-current-code",
    });
  });

  test("a file that never passed in this checkout is quiet", () => {
    const rs = history(
      { outcome: "passed", ownCheckout: false },
      { outcome: "failed", digest: "cur" },
      { outcome: "failed", digest: "cur" },
    );
    expect(judgeFailingFile("cur", rs)).toEqual({
      kind: "quiet",
      reason: "never-passed-here",
    });
  });

  test("failures only another checkout saw are quiet", () => {
    const rs = history(
      { outcome: "passed" },
      { outcome: "failed", digest: "cur", ownCheckout: false },
      { outcome: "failed", digest: "cur", ownCheckout: false },
    );
    expect(judgeFailingFile("cur", rs)).toEqual({
      kind: "quiet",
      reason: "not-seen-failing-here",
    });
  });

  test("only main's own failures confirm: one of main's plus a worktree's still asks to confirm", () => {
    const rs = history(
      { outcome: "passed" },
      { outcome: "failed", digest: "cur" },
      { outcome: "failed", digest: "cur", ownCheckout: false },
    );
    expect(judgeFailingFile("cur", rs)).toEqual({ kind: "confirm" });
  });

  test("the existing report stands in for a pass the results cap dropped", () => {
    const known = {
      lastPassed: { opId: "p", commit: "pass", at: new Date(1) },
      firstFailed: { opId: "f", commit: "fail", at: new Date(2) },
    };
    const rs = history(
      { outcome: "failed", digest: "cur" },
      { outcome: "failed", digest: "cur" },
    );
    const v = judgeFailingFile("cur", rs, known);
    expect(v.kind).toBe("report");
    if (v.kind !== "report") return;
    expect(v.lastPassed.commit).toBe("pass");
    expect(v.firstFailed.commit).toBe("fail");
    expect(judgeFailingFile("cur", rs)).toEqual({
      kind: "quiet",
      reason: "never-passed-here",
    });
  });
});
