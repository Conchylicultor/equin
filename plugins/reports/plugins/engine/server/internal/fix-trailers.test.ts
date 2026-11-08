import { describe, expect, test } from "bun:test";
import { reportIdKind } from "@plugins/reports/core";
import { parseFixLog } from "./fix-trailers";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const R1 = reportIdKind.key("report-1794143800-abc123");
const R2 = reportIdKind.key("report-1794143800-def456");

// One record as FIX_LOG_FORMAT emits it: sha, ISO time, push id, fixes.
const record = (sha: string, push: string, fixes: string) =>
  [sha, "2026-11-08T10:00:00+00:00", push, fixes].join("\x00") + "\x00\n";

describe("parseFixLog", () => {
  test("one claim per (report, push): the push's newest commit stands for it", () => {
    const raw =
      record(A, "push-1", R1) +
      record(B, "push-1", R1) +
      record(C, "push-2", R1);
    expect(parseFixLog(raw).map((c) => [c.reportId, c.commit])).toEqual([
      [R1, A],
      [R1, C],
    ]);
  });
  test("a trailer naming several reports claims each", () => {
    const claims = parseFixLog(record(A, "push-1", `${R1}, ${R2}`));
    expect(claims.map((c) => c.reportId)).toEqual([R1, R2]);
    expect(claims[0]?.landedAt.toISOString()).toBe("2026-11-08T10:00:00.000Z");
  });
  test("a commit without a push trailer stands for itself", () => {
    const raw = record(A, "", R1) + record(B, "", R1);
    expect(parseFixLog(raw).map((c) => c.commit)).toEqual([A, B]);
  });
  test("a value that is not a report id is a broken assumption", () => {
    expect(() => parseFixLog(record(A, "p", "task-1"))).toThrow(
      /not a report id/,
    );
  });
  test("no output, no claims", () => {
    expect(parseFixLog("")).toEqual([]);
  });
});
