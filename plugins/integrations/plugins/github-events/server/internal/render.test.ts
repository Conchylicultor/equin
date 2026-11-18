import { describe, expect, test } from "bun:test";
import { renderGitHubRunFailedTask } from "./render";

const row = {
  count: 2,
  firstSeenAt: new Date("2026-11-18T09:06:00Z"),
  lastSeenAt: new Date("2026-11-18T10:06:00Z"),
};

describe("the github-run-failed task", () => {
  test("names the failed jobs and steps, the run, the log command and the remedy", () => {
    const task = renderGitHubRunFailedTask(
      row,
      {
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
            url: "https://job",
            failedSteps: ["Smoke test"],
          },
        ],
      },
      [
        "Re-publish: `gh workflow run installer-release.yml -R equinai/equin -f ref=v2026.11.18 -f replace=true`.",
      ],
    );
    expect(task.title).toBe(
      "[github-run-failed] equinai/equin · Installer release failed on v2026.11.18 — Linux (linux-arm64)",
    );
    expect(task.description).toContain(
      "- [Linux (linux-arm64)](https://job) (failure) — step `Smoke test`",
    );
    expect(task.description).toContain(
      "**Run:** https://github.com/equinai/equin/actions/runs/19456123987",
    );
    expect(task.description).toContain(
      "`gh run view 19456123987 -R equinai/equin --log-failed`",
    );
    expect(task.description).toContain(
      "3. Re-publish: `gh workflow run installer-release.yml -R equinai/equin -f ref=v2026.11.18 -f replace=true`.",
    );
    expect(task.description).toContain("**Occurrences:** 2");
  });
});
