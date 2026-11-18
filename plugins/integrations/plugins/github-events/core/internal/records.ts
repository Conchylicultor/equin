import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { externalIdField } from "@plugins/ids/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The most failed jobs a run keeps, and the most failed steps a job keeps. A
 * watched workflow has a handful of jobs (installer-release: 7); the caps are
 * there so a matrix of hundreds cannot grow a row past reason.
 */
export const FAILED_JOBS_MAX = 50;
export const FAILED_STEPS_MAX = 20;

/** One failed job of a run, as `workflow_job` (or the run's job listing) told it. */
export const FailedJobSchema = z.object({
  /** GitHub's job id (a number, kept as text: it outgrows 2^31). */
  id: z.string(),
  name: z.string(),
  /** `failure`, `timed_out`, `cancelled`, … — GitHub's word. */
  conclusion: z.string(),
  url: z.string(),
  /** The names of the steps that failed, in order. */
  failedSteps: cappedList(z.string(), { max: FAILED_STEPS_MAX }),
});
export type FailedJob = z.infer<typeof FailedJobSchema>;

/**
 * One attempt of one workflow run of a watched workflow, as GitHub last told
 * it (`workflow_run` deliveries, and the listing a forwarder start catches up
 * with). Keyed by `id` = `<repo>#<run id>#<attempt>`.
 *
 * - `head` — what the run is about: the tag for a tag push, else the branch
 *   (GitHub's `head_branch`, which a tag push sets to the tag).
 * - `status` / `conclusion` — GitHub's own words (`queued`, `in_progress`,
 *   `completed`; `success`, `failure`, `timed_out`, …): an open set GitHub
 *   may grow, so text, never an enum that would refuse a new one.
 * - `githubUpdatedAt` — the run's `updated_at`: a delivery older than the
 *   stored one never overwrites it (deliveries can arrive out of order).
 * - `startedAt` — when this attempt started (`run_started_at`, else the run's
 *   `created_at`); `finishedAt` — when it completed (its `updated_at` once
 *   `status` is `completed`; GitHub sends no completion time of its own),
 *   null while it is queued or in progress. The pair the runs union's
 *   `startedAt` / `finishedAt` (and its "Took") read.
 * - `reportedAt` — when its failure was filed as a `github-run-failed`
 *   report: at most once per attempt.
 */
export const githubRunFields = {
  id: externalIdField({
    reason:
      "derived, not minted: `<repo>#<run id>#<attempt>`, GitHub's natural key of one run attempt",
  }),
  repo: textField({ label: "Repository" }),
  runId: textField({ label: "Run" }),
  attempt: intField({ label: "Attempt" }),
  workflowPath: textField({ label: "Workflow file" }),
  workflowName: textField({ label: "Workflow" }),
  event: textField({ label: "Event" }),
  head: textField({ label: "Head" }),
  headSha: textField({ label: "Commit" }),
  status: textField({ label: "Status" }),
  conclusion: nullable(textField({ label: "Conclusion" })),
  url: textField(),
  failedJobs: jsonField({
    schema: cappedList(FailedJobSchema, { max: FAILED_JOBS_MAX }),
    default: [],
  }),
  githubUpdatedAt: dateField({ label: "Updated on GitHub" }),
  startedAt: dateField({ label: "Started" }),
  finishedAt: nullable(dateField({ label: "Finished" })),
  reportedAt: nullable(dateField({ label: "Reported" })),
} satisfies FieldsRecord;
export const githubRunsEntityRef = entityRef("github_runs", githubRunFields);
export const GitHubRunSchema = fieldsToZodObject(githubRunFields);
export type GitHubRun = z.infer<typeof GitHubRunSchema>;

/** A run attempt's key: `<repo>#<run id>#<attempt>`. */
export function githubRunKey(repo: string, runId: string, attempt: number) {
  return `${repo}#${runId}#${attempt}`;
}

/** The most assets a release row keeps (a release publishes ~10). */
export const RELEASE_ASSETS_MAX = 100;

/**
 * One GitHub Release of a watched repo (`release` deliveries, and the listing
 * a forwarder start catches up with), keyed by `id` = `<repo>@<tag>`.
 * `draft` true until it is published; `assets` the names of the files
 * attached to it now.
 */
export const githubReleaseFields = {
  id: externalIdField({
    reason:
      "derived, not minted: `<repo>@<tag>`, GitHub's natural key of a release",
  }),
  repo: textField({ label: "Repository" }),
  tag: textField({ label: "Tag" }),
  draft: boolField({ label: "Draft" }),
  assets: jsonField({
    schema: cappedList(z.string(), { max: RELEASE_ASSETS_MAX }),
    default: [],
  }),
  url: textField(),
  githubUpdatedAt: dateField({ label: "Updated on GitHub" }),
} satisfies FieldsRecord;
export const githubReleasesEntityRef = entityRef(
  "github_releases",
  githubReleaseFields,
);
export const GitHubReleaseSchema = fieldsToZodObject(githubReleaseFields);
export type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

/** A release's key: `<repo>@<tag>`. */
export function githubReleaseKey(repo: string, tag: string) {
  return `${repo}@${tag}`;
}
