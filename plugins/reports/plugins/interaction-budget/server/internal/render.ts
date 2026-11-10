import type { ReportRow } from "@plugins/reports/server";
import {
  budgetCommitRange,
  interactionBudgetMessage,
  shortCommit,
  type InteractionBudgetPayload,
} from "../../core";

// The task body, kept apart from the `ReportKind` wiring (kind.ts) so it is
// testable without evaluating the reports plugin's server barrel.

export function renderInteractionBudgetTask(
  row: ReportRow,
  d: InteractionBudgetPayload,
): { title: string; description: string } {
  const lines: string[] = [
    `A budget run measured **${d.title}** on main's deploy of ` +
      `\`${shortCommit(d.commit)}\` and found it doing more work than its budget ` +
      `allows. The metric is ${d.metric} — a count of work, stable from run to ` +
      "run, not a time — so a jump is a change in the code, not a busy host.",
    "",
    `**Commit range:** \`${budgetCommitRange(d)}\`` +
      (d.lastWithinBudget === null
        ? " (no earlier run was within budget)."
        : ` — \`git log --oneline ${d.lastWithinBudget}..${d.commit}\` lists the candidates.`),
    "",
    `| Case | ${d.metric} (median) | Budget | Samples |`,
    "| --- | --- | --- | --- |",
    ...d.cases.map(
      (c) =>
        `| ${c.measured > c.budget ? "**over** " : ""}${c.label} | ${Math.round(c.measured)} | ${c.budget} | ${c.samples.join(", ")} |`,
    ),
    "",
    "**Reproduce** (in a worktree, after `./equin build`; exits non-zero while over budget):",
    "```",
    d.rerun,
    "```",
    "",
    d.hint,
    "",
    "Do not raise the budget to make this go away: find the change that added the " +
      "work and remove the work. A budget is raised only when the added work is " +
      "intended, with the reason in the commit.",
    "",
    `**Occurrences:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ];
  return {
    title: `[interaction-budget] ${interactionBudgetMessage(d)}`,
    description: lines.join("\n"),
  };
}
