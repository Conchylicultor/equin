import { describe, expect, test } from "bun:test";
import {
  DeliverySchemas,
  failedJobOf,
  jobRunKey,
  newestPerHead,
  releaseFacts,
  RunListSchema,
  runFacts,
  withFailedJob,
} from "./events";

// Trimmed real payloads (GitHub's own field names and nesting; extra fields
// kept to prove they are ignored).
const repository = { id: 1, full_name: "equinai/equin", private: false };
const workflowRun = {
  id: 19456123987,
  name: "Installer release",
  head_branch: "v2026.11.18",
  display_title: "fix(installer/window): no white flash",
  head_sha: "a2559eaca1f00000000000000000000000000000",
  path: ".github/workflows/installer-release.yml",
  run_number: 41,
  event: "push",
  status: "completed",
  conclusion: "failure",
  workflow_id: 2001,
  html_url: "https://github.com/equinai/equin/actions/runs/19456123987",
  run_attempt: 1,
  created_at: "2026-11-18T09:00:00Z",
  updated_at: "2026-11-18T09:06:12Z",
  repository,
  head_repository: repository,
};
const workflowJob = {
  id: 55012,
  run_id: 19456123987,
  run_attempt: 1,
  workflow_name: "Installer release",
  head_branch: "v2026.11.18",
  name: "Linux (linux-arm64)",
  status: "completed",
  conclusion: "failure",
  html_url:
    "https://github.com/equinai/equin/actions/runs/19456123987/job/55012",
  steps: [
    {
      name: "Set up job",
      status: "completed",
      conclusion: "success",
      number: 1,
    },
    {
      name: "Smoke test",
      status: "completed",
      conclusion: "failure",
      number: 7,
    },
    { name: "Upload", status: "completed", conclusion: "skipped", number: 8 },
  ],
};
const release = {
  id: 77,
  tag_name: "v2026.11.18",
  draft: false,
  prerelease: false,
  html_url: "https://github.com/equinai/equin/releases/tag/v2026.11.18",
  created_at: "2026-11-18T09:00:30Z",
  published_at: "2026-11-18T09:01:00Z",
  assets: [
    { name: "install.sh", updated_at: "2026-11-18T09:00:50Z", size: 10 },
    {
      name: "equin-installer-linux-x64",
      updated_at: "2026-11-18T09:05:00Z",
      size: 99,
    },
  ],
};

describe("GitHub payloads", () => {
  test("a workflow_run delivery becomes its run row", () => {
    const { workflow_run } = DeliverySchemas.workflow_run.parse({
      action: "completed",
      workflow_run: workflowRun,
      repository,
    });
    expect(runFacts(workflow_run, { headIsRunName: true })).toEqual({
      id: "equinai/equin#19456123987#1",
      repo: "equinai/equin",
      runId: "19456123987",
      attempt: 1,
      workflowPath: ".github/workflows/installer-release.yml",
      workflowName: "Installer release",
      event: "push",
      head: "v2026.11.18",
      headSha: "a2559eaca1f00000000000000000000000000000",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/equinai/equin/actions/runs/19456123987",
      githubUpdatedAt: new Date("2026-11-18T09:06:12Z"),
    });
  });

  test("a manual run's head is its run-name, when the watch says so", () => {
    // Dispatched FROM main to rebuild a tag: head_branch is main.
    const manual = DeliverySchemas.workflow_run.parse({
      action: "completed",
      workflow_run: {
        ...workflowRun,
        event: "workflow_dispatch",
        head_branch: "main",
        display_title: "v2026.11.18",
      },
      repository,
    }).workflow_run;
    expect(runFacts(manual, { headIsRunName: true }).head).toBe("v2026.11.18");
    expect(runFacts(manual, { headIsRunName: false }).head).toBe("main");
  });

  test("the REST run listing parses with the same schema", () => {
    const list = RunListSchema.parse({
      total_count: 1,
      workflow_runs: [workflowRun],
    });
    expect(
      list.workflow_runs.map((r) => runFacts(r, { headIsRunName: false }).id),
    ).toEqual(["equinai/equin#19456123987#1"]);
  });

  test("a failed job keeps its failed steps; a passing one is no failure", () => {
    const d = DeliverySchemas.workflow_job.parse({
      action: "completed",
      workflow_job: workflowJob,
      repository,
    });
    expect(jobRunKey("equinai/equin", d.workflow_job)).toBe(
      "equinai/equin#19456123987#1",
    );
    expect(failedJobOf(d.workflow_job)).toEqual({
      id: "55012",
      name: "Linux (linux-arm64)",
      conclusion: "failure",
      url: "https://github.com/equinai/equin/actions/runs/19456123987/job/55012",
      failedSteps: ["Smoke test"],
    });
    expect(
      failedJobOf({ ...d.workflow_job, conclusion: "success" }),
    ).toBeNull();
    expect(
      failedJobOf({
        ...d.workflow_job,
        status: "in_progress",
        conclusion: null,
      }),
    ).toBeNull();
  });

  test("a job delivered twice replaces its copy", () => {
    const job = failedJobOf(
      DeliverySchemas.workflow_job.parse({
        workflow_job: workflowJob,
        repository,
      }).workflow_job,
    );
    if (job === null) throw new Error("expected a failed job");
    expect(withFailedJob(withFailedJob([], job), job)).toEqual([job]);
  });

  test("a release keeps its asset names and its newest change", () => {
    const d = DeliverySchemas.release.parse({
      action: "edited",
      release,
      repository,
    });
    expect(releaseFacts("equinai/equin", d.release)).toEqual({
      id: "equinai/equin@v2026.11.18",
      repo: "equinai/equin",
      tag: "v2026.11.18",
      draft: false,
      assets: ["install.sh", "equin-installer-linux-x64"],
      url: "https://github.com/equinai/equin/releases/tag/v2026.11.18",
      githubUpdatedAt: new Date("2026-11-18T09:05:00Z"),
    });
  });

  test("a ping names its repo", () => {
    expect(
      DeliverySchemas.ping.parse({
        zen: "Design for failure.",
        hook_id: 3,
        repository,
      }).repository.full_name,
    ).toBe("equinai/equin");
  });
});

describe("catch-up filing", () => {
  const run = (head: string, path: string, at: string, id: string) => ({
    id,
    head,
    workflowPath: path,
    githubUpdatedAt: new Date(at),
  });

  test("only the newest run of each (workflow, head) may be reported", () => {
    const newestMain = run("main", "a.yml", "2026-11-18T05:00:00Z", "3");
    const runs = [
      run("main", "a.yml", "2026-11-16T05:00:00Z", "1"),
      newestMain,
      run("main", "a.yml", "2026-11-17T05:00:00Z", "2"),
      run("v1", "a.yml", "2026-11-10T00:00:00Z", "4"),
      run("main", "b.yml", "2026-11-01T00:00:00Z", "5"),
    ];
    expect(
      newestPerHead(runs)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["3", "4", "5"]);
  });
});
