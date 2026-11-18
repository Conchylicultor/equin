import type { FailedJob, GitHubRun } from "../../core";
import { githubWatches, releasesWatched } from "../../server";
import {
  failedJobOf,
  JobListSchema,
  newestPerHead,
  releaseFacts,
  ReleaseListSchema,
  RunListSchema,
  runFacts,
} from "./events";
import { ghApi } from "./gh";
import { reportIfFailed, upsertRelease, upsertRun } from "./ingest";

/** How many runs per workflow, and releases per repo, a catch-up reads. */
const CATCH_UP_RUNS = 10;
const CATCH_UP_RELEASES = 5;

/**
 * Read a run attempt's failed jobs from GitHub — for a failed run no
 * `workflow_job` delivery told about (it failed while no forwarder was
 * connected, or its jobs' deliveries raced ahead of the run's).
 */
export function failedJobsLoader(
  gh: string,
): (run: GitHubRun) => Promise<FailedJob[]> {
  return async (run) => {
    const { jobs } = await ghApi(
      gh,
      `repos/${run.repo}/actions/runs/${run.runId}/attempts/${run.attempt}/jobs?per_page=100`,
      JobListSchema,
    );
    return jobs.flatMap((j) => {
      const failed = failedJobOf(j);
      return failed === null ? [] : [failed];
    });
  };
}

/** Re-read a repo's newest releases (a `release` event is not sent for an asset upload). */
export async function refreshReleases(gh: string, repo: string): Promise<void> {
  const releases = await ghApi(
    gh,
    `repos/${repo}/releases?per_page=${CATCH_UP_RELEASES}`,
    ReleaseListSchema,
  );
  for (const r of releases) await upsertRelease(releaseFacts(repo, r));
}

/**
 * What a forwarder missed while it was not connected, read once when GitHub
 * pings it (connect and every reconnect) — never on a timer: nothing runs
 * again until the next connect. Each watched workflow's newest runs, the
 * repo's newest releases when watched, all through the deliveries' upserts;
 * the newest run of each head that failed is reported (once per attempt).
 */
export async function catchUp(gh: string, repo: string): Promise<void> {
  const loadJobs = failedJobsLoader(gh);
  for (const watch of githubWatches().filter((w) => w.repo === repo)) {
    const { workflow_runs } = await ghApi(
      gh,
      `repos/${repo}/actions/workflows/${watch.workflow}/runs?per_page=${CATCH_UP_RUNS}`,
      RunListSchema,
    );
    const stored: GitHubRun[] = [];
    for (const run of workflow_runs)
      stored.push(
        await upsertRun(
          runFacts(run, { headIsRunName: watch.headIsRunName === true }),
        ),
      );
    for (const run of newestPerHead(stored))
      await reportIfFailed(run, loadJobs);
  }
  if (releasesWatched(repo)) await refreshReleases(gh, repo);
}
