import { z } from "zod";
import {
  FAILED_STEPS_MAX,
  githubReleaseKey,
  githubRunKey,
  RELEASE_ASSETS_MAX,
  type FailedJob,
  type GitHubRelease,
  type GitHubRun,
} from "../../core";

// GitHub's shapes, only the fields kept. The same objects arrive in a webhook
// delivery (`workflow_run`, `workflow_job`, `release`) and in the REST
// listings a catch-up reads, so one schema parses both.

const RepositorySchema = z.object({ full_name: z.string() });

/** A workflow run (REST `/actions/runs`, webhook `workflow_run.workflow_run`). */
export const RunSchema = z.object({
  id: z.number().int(),
  run_attempt: z.number().int(),
  /** `.github/workflows/<file>` (a reusable call appends `@<ref>`: never watched). */
  path: z.string(),
  name: z.string().nullable(),
  event: z.string(),
  head_branch: z.string().nullable(),
  /** The run's title: the workflow's `run-name`, else the commit's subject. */
  display_title: z.string(),
  head_sha: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  updated_at: z.string(),
  repository: RepositorySchema,
});
export type GitHubRunPayload = z.infer<typeof RunSchema>;

/** One job (REST `/actions/runs/<id>/attempts/<n>/jobs`, webhook `workflow_job`). */
export const JobSchema = z.object({
  id: z.number().int(),
  run_id: z.number().int(),
  run_attempt: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
  steps: z
    .array(z.object({ name: z.string(), conclusion: z.string().nullable() }))
    .nullable()
    .optional(),
});
export type GitHubJobPayload = z.infer<typeof JobSchema>;

/** A release (REST `/releases`, webhook `release.release`). */
export const ReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  html_url: z.string(),
  created_at: z.string(),
  published_at: z.string().nullable(),
  assets: z.array(z.object({ name: z.string(), updated_at: z.string() })),
});
export type GitHubReleasePayload = z.infer<typeof ReleaseSchema>;

/**
 * One delivery, by its `X-GitHub-Event`. An event a forwarder is not asked for
 * is refused by the caller before it gets here.
 */
export const DeliverySchemas = {
  ping: z.object({ repository: RepositorySchema }),
  workflow_run: z.object({ workflow_run: RunSchema }),
  workflow_job: z.object({
    repository: RepositorySchema,
    workflow_job: JobSchema,
  }),
  release: z.object({
    action: z.string(),
    repository: RepositorySchema,
    release: ReleaseSchema,
  }),
} as const;
export type DeliveryEvent = keyof typeof DeliverySchemas;
export const DELIVERY_EVENTS = Object.keys(DeliverySchemas) as DeliveryEvent[];

/** The events a forwarder forwards (`ping` comes on its own). */
export const FORWARDED_EVENTS = ["workflow_run", "workflow_job", "release"];

/** The REST listings' envelopes. */
export const RunListSchema = z.object({ workflow_runs: z.array(RunSchema) });
export const JobListSchema = z.object({ jobs: z.array(JobSchema) });
export const ReleaseListSchema = z.array(ReleaseSchema);

/** The conclusions that make a job a failed one. */
const FAILED_JOB_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"]);

/** A run as its row stores it — everything but what the row accrues (failed jobs, reported). */
export type RunFacts = Omit<GitHubRun, "failedJobs" | "reportedAt">;

/**
 * `headIsRunName`: the watch declares its `run-name` IS the ref the run works
 * on (see `GitHubWatch.headIsRunName`) — read the head from the title.
 */
export function runFacts(
  run: GitHubRunPayload,
  { headIsRunName }: { headIsRunName: boolean },
): RunFacts {
  const repo = run.repository.full_name;
  const runId = String(run.id);
  return {
    id: githubRunKey(repo, runId, run.run_attempt),
    repo,
    runId,
    attempt: run.run_attempt,
    workflowPath: run.path,
    workflowName: run.name ?? run.path,
    event: run.event,
    // A tag push's head_branch IS the tag; a manual run's is the branch it
    // was dispatched from, so a watch whose run-name is its ref reads that
    // (a push's title stays the commit subject — runs from before the
    // run-name included).
    head:
      headIsRunName && run.event === "workflow_dispatch"
        ? run.display_title
        : (run.head_branch ?? run.head_sha),
    headSha: run.head_sha,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    url: run.html_url,
    githubUpdatedAt: new Date(run.updated_at),
  };
}

/** The run attempt a job belongs to. */
export function jobRunKey(repo: string, job: GitHubJobPayload): string {
  return githubRunKey(repo, String(job.run_id), job.run_attempt);
}

/** A completed job that failed, as a run row keeps it; `null` for any other job. */
export function failedJobOf(job: GitHubJobPayload): FailedJob | null {
  if (job.status !== "completed") return null;
  if (job.conclusion === null || !FAILED_JOB_CONCLUSIONS.has(job.conclusion))
    return null;
  return {
    id: String(job.id),
    name: job.name,
    conclusion: job.conclusion,
    url: job.html_url ?? "",
    failedSteps: (job.steps ?? [])
      .filter(
        (s) =>
          s.conclusion !== null && FAILED_JOB_CONCLUSIONS.has(s.conclusion),
      )
      .map((s) => s.name)
      .slice(0, FAILED_STEPS_MAX),
  };
}

/** A run's failed jobs merged with one more (replacing its earlier copy). */
export function withFailedJob(
  jobs: readonly FailedJob[],
  job: FailedJob,
): FailedJob[] {
  return [...jobs.filter((j) => j.id !== job.id), job];
}

/**
 * When a release last changed: its creation, its publication, or an asset
 * attached (GitHub's release object has no `updated_at` of its own).
 */
function releaseChangedAt(r: GitHubReleasePayload): Date {
  const stamps = [
    r.created_at,
    r.published_at,
    ...r.assets.map((a) => a.updated_at),
  ]
    .filter((s): s is string => s !== null)
    .map((s) => Date.parse(s));
  return new Date(Math.max(...stamps));
}

export function releaseFacts(
  repo: string,
  r: GitHubReleasePayload,
): GitHubRelease {
  return {
    id: githubReleaseKey(repo, r.tag_name),
    repo,
    tag: r.tag_name,
    draft: r.draft,
    assets: r.assets.map((a) => a.name).slice(0, RELEASE_ASSETS_MAX),
    url: r.html_url,
    githubUpdatedAt: releaseChangedAt(r),
  };
}

/**
 * The runs a catch-up listing may report: per (workflow, head), only the
 * newest — an older failure a later run of the same head superseded is not
 * news. The listing is GitHub's newest first, but the order is not trusted.
 */
export function newestPerHead<
  T extends { workflowPath: string; head: string; githubUpdatedAt: Date },
>(runs: readonly T[]): T[] {
  const newest = new Map<string, T>();
  for (const run of runs) {
    const key = `${run.workflowPath}\u0000${run.head}`;
    const held = newest.get(key);
    if (held === undefined || run.githubUpdatedAt > held.githubUpdatedAt)
      newest.set(key, run);
  }
  return [...newest.values()];
}
