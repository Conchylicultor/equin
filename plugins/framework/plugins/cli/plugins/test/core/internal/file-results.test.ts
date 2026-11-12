import { describe, expect, test } from "bun:test";
import { fileResults, JunitPathMismatchError } from "./file-results";
import type { JunitSummary } from "./junit";

const digests = new Map([
  ["a.test.ts", "da"],
  ["b.test.ts", "db"],
  ["c.test.ts", "dc"],
]);
const files = ["a.test.ts", "b.test.ts", "c.test.ts"];

const report: JunitSummary = {
  failures: ["b.test.ts > grp > x"],
  files: ["a.test.ts", "b.test.ts"],
  byFile: {
    "a.test.ts": { cases: 3, failed: 0, timeMs: 12 },
    "b.test.ts": { cases: 2, failed: 1, timeMs: 40 },
  },
  failureDetails: [
    { file: "b.test.ts", caseId: "grp > x", message: "boom", detail: "stack" },
  ],
};

describe("fileResults", () => {
  test("reported files are passed / failed; a missing one under a red runner is not-loaded", () => {
    const r = fileResults({
      runner: "bun:test",
      files,
      exitCode: 1,
      wedged: false,
      report,
      digests,
    });
    expect(r.unattributed).toBe(false);
    expect(
      r.files.map((f) => [f.path, f.outcome, f.cases, f.failedCases]),
    ).toEqual([
      ["a.test.ts", "passed", 3, 0],
      ["b.test.ts", "failed", 2, 1],
      ["c.test.ts", "not-loaded", 0, 0],
    ]);
    expect(r.files[1]!.digest).toBe("db");
    expect(r.failures).toEqual([
      {
        path: "b.test.ts",
        caseId: "grp > x",
        message: "boom",
        detail: "stack",
      },
    ]);
  });

  test("a file missing from a green runner's report gets no row", () => {
    const r = fileResults({
      runner: "bun:test",
      files,
      exitCode: 0,
      wedged: false,
      report: { ...report, failures: [], failureDetails: [] },
      digests,
    });
    expect(r.files.map((f) => f.path)).toEqual(["a.test.ts", "b.test.ts"]);
  });

  test("a wedged runner or one with no report attributes nothing", () => {
    for (const input of [
      { wedged: true, report },
      { wedged: false, report: null },
    ]) {
      const r = fileResults({
        runner: "vitest",
        files,
        exitCode: 1,
        digests,
        ...input,
      });
      expect(r).toEqual({ files: [], failures: [], unattributed: true });
    }
  });

  test("a report naming a file the runner was not given is a loud mismatch", () => {
    expect(() =>
      fileResults({
        runner: "vitest",
        files: ["a.test.ts"],
        exitCode: 0,
        wedged: false,
        report,
        digests,
      }),
    ).toThrow(JunitPathMismatchError);
  });
});
