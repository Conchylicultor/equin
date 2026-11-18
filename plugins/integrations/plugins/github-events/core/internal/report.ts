import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { FAILED_JOBS_MAX, FailedJobSchema } from "./records";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it, the web dispatches its `Reports.KindView` on it, the machine
 * files under it.
 */
export const GITHUB_RUN_FAILED_KIND = "github-run-failed";

/** The conclusions that are a failure worth a report. */
export const FAILED_CONCLUSIONS: readonly string[] = ["failure", "timed_out"];

/** The run events that never file a report: a pull request's CI is the PR's. */
export const UNREPORTED_EVENTS: readonly string[] = ["pull_request"];

/**
 * One failed run attempt of a watched workflow. The row keeps the latest
 * occurrence's payload, so it names the newest failing run.
 */
export const GitHubRunFailedPayloadSchema = z.object({
  repo: z.string(),
  /** The workflow file's name (`installer-release.yml`). */
  workflow: z.string(),
  /** The workflow's display name (`Installer release`). */
  workflowName: z.string(),
  event: z.string(),
  /** The tag for a tag push, else the branch. */
  head: z.string(),
  sha: z.string(),
  runId: z.string(),
  attempt: z.number().int(),
  conclusion: z.string(),
  url: z.string(),
  failedJobs: cappedList(FailedJobSchema, { max: FAILED_JOBS_MAX }),
});
export type GitHubRunFailedPayload = z.infer<
  typeof GitHubRunFailedPayloadSchema
>;

/**
 * One row per (repo, workflow, head): a re-run of the same tag, or the same
 * daily cron failing again on main, collapses onto the row it already has.
 */
export function githubRunFailedFingerprint(d: GitHubRunFailedPayload): string {
  return `${GITHUB_RUN_FAILED_KIND}:${d.repo}:${d.workflow}:${d.head}`;
}

/** "equinai/equin · Installer release failed on v2026.11.18 — Linux (linux-arm64)". */
export function githubRunFailedMessage(d: GitHubRunFailedPayload): string {
  const jobs = d.failedJobs.map((j) => j.name);
  const where =
    jobs.length === 0
      ? ""
      : ` — ${jobs.slice(0, 3).join(", ")}${jobs.length > 3 ? ` +${jobs.length - 3}` : ""}`;
  const verb = d.conclusion === "timed_out" ? "timed out" : "failed";
  return `${d.repo} · ${d.workflowName} ${verb} on ${d.head}${where}`;
}

/** Whether a completed run attempt is a failure worth a report. */
export function isReportableFailure(run: {
  status: string;
  conclusion: string | null;
  event: string;
}): boolean {
  return (
    run.status === "completed" &&
    run.conclusion !== null &&
    FAILED_CONCLUSIONS.includes(run.conclusion) &&
    !UNREPORTED_EVENTS.includes(run.event)
  );
}
