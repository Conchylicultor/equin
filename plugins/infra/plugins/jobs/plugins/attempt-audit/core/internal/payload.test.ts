import { describe, expect, test } from "bun:test";
import { attemptReportMessage, type JobAttemptFailedPayload } from "./payload";

const base: JobAttemptFailedPayload = {
  jobName: "worktree.prepare",
  jobId: "42",
  workflowRunId: "worktree.prepare:job:42",
  attempt: 1,
  maxAttempts: 5,
  error: "Cannot find module './x'",
  errorType: "Error",
  stack: null,
  fate: { state: "retrying" },
};

describe("attemptReportMessage", () => {
  test("leads with the fate, so the bell's one-line cut keeps it", () => {
    expect(attemptReportMessage(base)).toBe(
      "Retrying · worktree.prepare failed on attempt 1/5: Cannot find module './x'",
    );
    expect(
      attemptReportMessage({
        ...base,
        fate: { state: "recovered", attempt: 2, suspended: false, at: 0 },
      }).startsWith("Recovered on attempt 2 · "),
    ).toBe(true);
    expect(
      attemptReportMessage({
        ...base,
        fate: { state: "gave-up", cause: "worker-died", error: "", at: 0 },
      }).startsWith("Gave up — its worker died on its last attempt · "),
    ).toBe(true);
  });
});
