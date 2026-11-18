import { describe, expect, test } from "bun:test";
import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import { buildFailureEnd } from "./failure-end";

const FINISHED = new Date("2026-11-18T12:00:00Z");
const statusOf = (exitCode: number) =>
  buildStatusOf({ finishedAt: FINISHED, exitCode });

describe("buildFailureEnd", () => {
  test("a failure made only of killed children ends killed — no verdict in the ledger", () => {
    const end = buildFailureEnd({
      supersededBy: null,
      failures: [{ killedBy: "SIGKILL" }],
    });
    expect(end).toEqual({ kind: "killed", signal: "SIGKILL", exitCode: 137 });
    expect(statusOf(end.exitCode)).toBe("killed");
  });

  test("one failure that judged the code makes the build failed", () => {
    const end = buildFailureEnd({
      supersededBy: null,
      failures: [{ killedBy: "SIGKILL" }, { killedBy: null }],
    });
    expect(end).toEqual({ kind: "failed", exitCode: 1 });
    expect(statusOf(end.exitCode)).toBe("failed");
  });

  test("a failure with no named cause is failed, never a kill", () => {
    expect(buildFailureEnd({ supersededBy: null, failures: [] }).kind).toBe(
      "failed",
    );
  });

  test("a superseded build stays superseded, kills or not", () => {
    const end = buildFailureEnd({
      supersededBy: "abc123",
      failures: [{ killedBy: "SIGKILL" }],
    });
    expect(end.kind).toBe("superseded");
    expect(statusOf(end.exitCode)).toBe("superseded");
  });
});
