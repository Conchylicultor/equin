import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  GITHUB_RUN_FAILED_KIND,
  githubRunFailedFingerprint,
  GitHubRunFailedPayloadSchema,
} from "../../core";
import { renderGitHubRunFailedTask } from "./render";
import { watchFor } from "./watch";

/** The `github-run-failed` report kind — see this plugin's CLAUDE.md. */
export const githubRunFailedKind = ReportKind({
  kind: GITHUB_RUN_FAILED_KIND,
  schema: GitHubRunFailedPayloadSchema,
  fingerprint: githubRunFailedFingerprint,
  meta: {
    tag: "[github-run-failed]",
    notif: "A GitHub workflow failed",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = GitHubRunFailedPayloadSchema.parse(row.data);
    const watch = watchFor(d.repo, d.workflow);
    const remedy =
      watch?.remedy?.({
        repo: d.repo,
        head: d.head,
        runId: d.runId,
        event: d.event,
      }) ?? [];
    return renderGitHubRunFailedTask(row, d, remedy);
  },
});
