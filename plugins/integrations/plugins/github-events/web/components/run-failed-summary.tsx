import type { Report } from "@plugins/reports/core";
import {
  githubRunFailedMessage,
  GitHubRunFailedPayloadSchema,
} from "../../core";

// One-line summary for the Debug → Reports list, e.g.
// "equinai/equin · Installer release failed on v2026.11.18 — Linux (linux-arm64)".
export function GitHubRunFailedSummary({ report }: { report: Report }) {
  const parsed = GitHubRunFailedPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  return <>{githubRunFailedMessage(parsed.data)}</>;
}
