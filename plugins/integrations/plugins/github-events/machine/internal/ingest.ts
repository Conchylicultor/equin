import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  GITHUB_RUN_FAILED_KIND,
  githubRunFailedMessage,
  isReportableFailure,
  type FailedJob,
  type GitHubRelease,
  type GitHubRun,
  type GitHubRunFailedPayload,
} from "../../core";
import { _githubReleases, _githubRuns, workflowFileOf } from "../../server";
import { withFailedJob, type RunFacts } from "./events";

// The one write path of both tables: a delivery and a catch-up listing go
// through the same upserts, so the two can never store a run differently.

/** Serializes the read-merge-write of one run's failed jobs. */
const runLocks = createKeyedMutex();

/**
 * Store what GitHub says of a run attempt. A delivery older than the row
 * (`updated_at` behind the stored one — deliveries arrive out of order) changes
 * nothing; what the row accrued (failed jobs, reported) is never overwritten.
 * Answers the row as stored now.
 */
export async function upsertRun(facts: RunFacts): Promise<GitHubRun> {
  const { id: _id, ...set } = facts;
  await db
    .insert(_githubRuns)
    .values({ ...facts, failedJobs: [], reportedAt: null })
    .onConflictDoUpdate({
      target: _githubRuns.id,
      set,
      setWhere: sql`excluded.github_updated_at >= ${_githubRuns.githubUpdatedAt}`,
    });
  return readRun(facts.id);
}

async function readRun(id: string): Promise<GitHubRun> {
  const [row] = await db
    .select()
    .from(_githubRuns)
    .where(eq(_githubRuns.id, id));
  if (row === undefined)
    throw new Error(
      `[github-events] run ${id} vanished right after its upsert`,
    );
  return row;
}

/**
 * Add a failed job to the run it belongs to. `false` when that run is not
 * stored — a job of an unwatched workflow (its run was never stored), or one
 * that raced ahead of its run's first delivery: either way the run's failure
 * report reads its jobs from GitHub when it finds none.
 */
export async function addFailedJob(
  runKey: string,
  job: FailedJob,
): Promise<boolean> {
  return runLocks.run(runKey, async () => {
    const [row] = await db
      .select({ failedJobs: _githubRuns.failedJobs })
      .from(_githubRuns)
      .where(eq(_githubRuns.id, runKey));
    if (row === undefined) return false;
    await db
      .update(_githubRuns)
      .set({ failedJobs: withFailedJob(row.failedJobs, job) })
      .where(eq(_githubRuns.id, runKey));
    return true;
  });
}

/** Replace a run's failed jobs with GitHub's whole listing of them. */
export async function setFailedJobs(
  runKey: string,
  jobs: FailedJob[],
): Promise<void> {
  await runLocks.run(runKey, async () => {
    await db
      .update(_githubRuns)
      .set({ failedJobs: jobs })
      .where(eq(_githubRuns.id, runKey));
  });
}

/** Store what GitHub says of a release (an older state never overwrites a newer one). */
export async function upsertRelease(release: GitHubRelease): Promise<void> {
  const { id: _id, ...set } = release;
  await db
    .insert(_githubReleases)
    .values(release)
    .onConflictDoUpdate({
      target: _githubReleases.id,
      set,
      setWhere: sql`excluded.github_updated_at >= ${_githubReleases.githubUpdatedAt}`,
    });
}

/** A release deleted on GitHub. */
export async function deleteRelease(id: string): Promise<void> {
  await db.delete(_githubReleases).where(eq(_githubReleases.id, id));
}

/**
 * File a run attempt's failure as a `github-run-failed` report — once per
 * attempt. The claim (`reported_at`, set only where it is still null) is the
 * guard, so a delivery and a catch-up racing on the same run file it once;
 * a record that fails gives the claim back and throws.
 *
 * `loadJobs` reads the run's failed jobs from GitHub, for a run whose jobs
 * no delivery brought.
 */
export async function reportIfFailed(
  run: GitHubRun,
  loadJobs: (run: GitHubRun) => Promise<FailedJob[]>,
): Promise<void> {
  if (!isReportableFailure(run) || run.reportedAt !== null) return;
  const claimed = await db
    .update(_githubRuns)
    .set({ reportedAt: new Date() })
    .where(and(eq(_githubRuns.id, run.id), isNull(_githubRuns.reportedAt)))
    .returning({ id: _githubRuns.id });
  if (claimed.length === 0) return;
  try {
    let jobs = run.failedJobs;
    if (jobs.length === 0) {
      jobs = await loadJobs(run);
      await setFailedJobs(run.id, jobs);
    }
    const data = failurePayload(run, jobs);
    await recordReport({
      kind: GITHUB_RUN_FAILED_KIND,
      source: "server-github-events",
      data,
      message: githubRunFailedMessage(data),
      url: run.url,
    });
  } catch (err) {
    await db
      .update(_githubRuns)
      .set({ reportedAt: null })
      .where(eq(_githubRuns.id, run.id));
    throw err;
  }
}

function failurePayload(
  run: GitHubRun,
  jobs: FailedJob[],
): GitHubRunFailedPayload {
  return {
    repo: run.repo,
    workflow: workflowFileOf(run.workflowPath),
    workflowName: run.workflowName,
    event: run.event,
    head: run.head,
    sha: run.headSha,
    runId: run.runId,
    attempt: run.attempt,
    conclusion: run.conclusion ?? "unknown",
    url: run.url,
    failedJobs: jobs,
  };
}

/**
 * The newest stored attempt of `workflowPath`'s runs on `head` — what the
 * publisher's releases row reads for a release tag. `null`: none stored.
 */
export async function newestRunOf(q: {
  repo: string;
  workflowPath: string;
  head: string;
}): Promise<GitHubRun | null> {
  const [row] = await db
    .select()
    .from(_githubRuns)
    .where(
      and(
        eq(_githubRuns.repo, q.repo),
        eq(_githubRuns.workflowPath, q.workflowPath),
        eq(_githubRuns.head, q.head),
      ),
    )
    .orderBy(desc(_githubRuns.githubUpdatedAt), desc(_githubRuns.attempt))
    .limit(1);
  return row ?? null;
}

/** The stored release of `repo` tagged `tag`; `null`: none stored. */
export async function releaseOf(
  repo: string,
  tag: string,
): Promise<GitHubRelease | null> {
  const [row] = await db
    .select()
    .from(_githubReleases)
    .where(and(eq(_githubReleases.repo, repo), eq(_githubReleases.tag, tag)));
  return row ?? null;
}
