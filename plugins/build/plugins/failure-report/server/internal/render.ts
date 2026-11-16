import type { ReportRow } from "@plugins/reports/server";
import { buildFailedMessage, type BuildFailedPayload } from "../../core";

// The task body, kept apart from the `ReportKind` wiring (kind.ts) so it is
// readable without evaluating the reports plugin's server barrel.

export function renderBuildFailedTask(
  row: ReportRow,
  d: BuildFailedPayload,
): { title: string; description: string } {
  const lines: string[] = [
    `**${buildFailedMessage(d)}**`,
    "",
    "A build of main failed, so main still serves its previous build and every push " +
      "since then has not reached it. This report is the failure, deduped on what failed " +
      "(the step, and its failing checks or error line) — not on the run: every build that " +
      "fails the same way bumps its count.",
    "",
    "**Latest run**",
    "",
    `- build run id: \`${d.runId}\` (in the merged runs list as \`build:${d.runId}\`)`,
    `- commit: \`${d.commit ?? "(none recorded)"}\``,
    `- trigger: \`${d.trigger}\`, targets: ${d.targets.join(", ") || "(none)"}`,
    `- exit code: ${d.exitCode}`,
    `- failing step: ${d.step ?? "(outside any step — a crash or abort before the verdict)"}`,
  ];
  if (d.checks.length > 0) {
    lines.push(
      `- failing checks: ${d.checks.map((c) => `\`${c}\``).join(", ")}`,
    );
  }
  if (d.error !== null) lines.push(`- error: \`${d.error}\``);
  lines.push("");
  if (d.noTranscript) {
    lines.push("The run left no transcript (pruned, or never written).");
  } else {
    lines.push("**Last lines of the failing stretch:**", "", "```");
    lines.push(...(d.tail.length > 0 ? d.tail : ["(none)"]));
    lines.push("```");
  }
  lines.push(
    "",
    "**Where to dig:** the run's transcript (Build → this run: each step's output, " +
      "the failing one last) and its ledger row " +
      `(\`select * from build_runs where id = '${d.runId}'\` via \`query_db\` on main). ` +
      "Reproduce from a worktree on main's commit with `./equin build`.",
    "",
    "Find the root cause and fix it. A fix that lands with `./equin push --fixes-report <this report's id>` " +
      "is marked Fixed once main builds it, and Regressed if this failure comes back.",
    "",
    `**Occurrences:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  );
  return {
    title: `[build-failed] ${buildFailedMessage(d)}`,
    description: lines.join("\n"),
  };
}
