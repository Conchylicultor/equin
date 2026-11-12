import { describe, expect, test } from "bun:test";
import { deriveStatus, worstStatus } from "./status";

describe("deriveStatus", () => {
  test("no result at all is never", () => {
    expect(deriveStatus("d1", [])).toBe("never");
  });
  test("only older digests is stale", () => {
    expect(deriveStatus("d2", [{ digest: "d1", outcome: "failed" }])).toBe(
      "stale",
    );
  });
  test("only passes on the current digest is passing", () => {
    expect(
      deriveStatus("d1", [
        { digest: "d1", outcome: "passed" },
        { digest: "d0", outcome: "failed" },
      ]),
    ).toBe("passing");
  });
  test("only failures (a failed case or a load crash) is failing", () => {
    expect(
      deriveStatus("d1", [
        { digest: "d1", outcome: "failed" },
        { digest: "d1", outcome: "not-loaded" },
      ]),
    ).toBe("failing");
  });
  test("a pass and a failure on one digest is flaky", () => {
    expect(
      deriveStatus("d1", [
        { digest: "d1", outcome: "passed" },
        { digest: "d1", outcome: "failed" },
      ]),
    ).toBe("flaky");
  });
});

describe("worstStatus", () => {
  test("failing beats flaky beats stale beats passing beats never", () => {
    expect(worstStatus("passing", "failing")).toBe("failing");
    expect(worstStatus("flaky", "stale")).toBe("flaky");
    expect(worstStatus("never", "passing")).toBe("passing");
  });
});
