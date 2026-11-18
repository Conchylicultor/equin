import { describe, expect, test } from "bun:test";
import {
  githubRunFailedFingerprint,
  githubRunFailedMessage,
  isReportableFailure,
  type GitHubRunFailedPayload,
} from "./report";

const payload: GitHubRunFailedPayload = {
  repo: "equinai/equin",
  workflow: "installer-release.yml",
  workflowName: "Installer release",
  event: "push",
  head: "v2026.11.18",
  sha: "a2559eaca1f00000000000000000000000000000",
  runId: "19456123987",
  attempt: 1,
  conclusion: "failure",
  url: "https://github.com/equinai/equin/actions/runs/19456123987",
  failedJobs: [
    {
      id: "1",
      name: "Linux (linux-arm64)",
      conclusion: "failure",
      url: "u",
      failedSteps: ["Smoke test"],
    },
  ],
};

describe("github-run-failed", () => {
  test("one row per repo, workflow and head: a re-run collapses onto it", () => {
    const fp = githubRunFailedFingerprint(payload);
    expect(fp).toBe(
      "github-run-failed:equinai/equin:installer-release.yml:v2026.11.18",
    );
    expect(
      githubRunFailedFingerprint({ ...payload, runId: "2", attempt: 2 }),
    ).toBe(fp);
    expect(
      githubRunFailedFingerprint({ ...payload, head: "v2026.11.19" }),
    ).not.toBe(fp);
  });

  test("the message names the run and its failed jobs", () => {
    expect(githubRunFailedMessage(payload)).toBe(
      "equinai/equin · Installer release failed on v2026.11.18 — Linux (linux-arm64)",
    );
    expect(
      githubRunFailedMessage({
        ...payload,
        conclusion: "timed_out",
        failedJobs: [],
      }),
    ).toBe("equinai/equin · Installer release timed out on v2026.11.18");
  });

  test("a completed failure or timeout is reported, except a pull request's", () => {
    const run = { status: "completed", conclusion: "failure", event: "push" };
    expect(isReportableFailure(run)).toBe(true);
    expect(isReportableFailure({ ...run, conclusion: "timed_out" })).toBe(true);
    expect(isReportableFailure({ ...run, event: "schedule" })).toBe(true);
    expect(isReportableFailure({ ...run, event: "pull_request" })).toBe(false);
    expect(isReportableFailure({ ...run, conclusion: "success" })).toBe(false);
    expect(isReportableFailure({ ...run, conclusion: "cancelled" })).toBe(
      false,
    );
    expect(
      isReportableFailure({ ...run, status: "in_progress", conclusion: null }),
    ).toBe(false);
  });
});
