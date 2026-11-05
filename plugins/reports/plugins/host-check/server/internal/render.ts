import type { ReportRow } from "@plugins/reports/server";
import { hostCheckMessage, type HostCheckPayload } from "../../core";

// The task body, kept apart from the `ReportKind` wiring (kind.ts) so it is
// testable without evaluating the reports plugin's server barrel.

export function renderHostCheckTask(
  row: ReportRow,
  d: HostCheckPayload,
): { title: string; description: string } {
  const lines: string[] = [
    `Main's hourly host audit (\`checks.host-audit\`, which runs ` +
      "`./equin check --scope host`) found this machine's shared state failing " +
      `\`${d.checkId}\`. A host check is about the machine — the shared data root, ` +
      "the keychain, host services — not about any branch, so no worktree's own " +
      "check pass runs it; this report is where its verdict lands.",
    "",
    "**What to do:**",
    `1. See the current state: \`./equin check ${d.checkId}\` (the message below is from the latest audit, which may be up to an hour old).`,
    "2. Find who created the offending state before removing it — another live " +
      "agent may still be using it. Then fix it at the source: declare what " +
      "should exist, delete what is debris.",
    "",
    "**Check message (latest audit):**",
    "```",
    d.message,
    "```",
  ];
  if (d.hint !== null) {
    lines.push("", `**Hint:** ${d.hint}`);
  }
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return {
    title: `[host-check] ${hostCheckMessage(d)}`,
    description: lines.join("\n"),
  };
}
