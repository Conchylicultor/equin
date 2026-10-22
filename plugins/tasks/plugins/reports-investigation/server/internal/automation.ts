import { symbol } from "@plugins/ui/plugins/icons/core";
import { defineAutomation } from "@plugins/tasks/plugins/automations/server";
import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  linkReportsToTask,
  renderReportTask,
  uninvestigatedReports,
} from "@plugins/reports/plugins/engine/server";
import {
  reportInvestigationsConfig,
  REPORT_INVESTIGATIONS_ID,
} from "../../shared/config";
import {
  MAX_REPORTS_PER_TASK,
  REPORT_SEVERITIES,
  severityInScope,
} from "../../shared/scope";
import { REPORTS_CATEGORY_ID } from "./register";

/** The registered report kinds a scope covers. */
function kindsInScope(config: {
  severity: string;
  excludedKinds: readonly string[];
}): string[] {
  const severity = REPORT_SEVERITIES.find((s) => s === config.severity);
  if (severity === undefined) {
    throw new Error(
      `report-investigations: severity "${config.severity}" is not one of ${REPORT_SEVERITIES.join(", ")}`,
    );
  }
  const excluded = new Set(config.excludedKinds);
  return ReportKind.getContributions()
    .filter(
      (k) => !excluded.has(k.kind) && severityInScope(k.meta.variant, severity),
    )
    .map((k) => k.kind);
}

/** Every report in the batch, grouped by kind, each as its kind renders it. */
function reportsSection(rows: readonly ReportRow[]): string {
  const byKind = new Map<string, ReportRow[]>();
  for (const row of rows) {
    byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
  }
  return [...byKind]
    .map(([kind, list]) =>
      [
        `## ${kind} ×${list.length}`,
        ...list.map((row) => {
          const { title, description } = renderReportTask(row);
          return `### ${title}\n\nReport \`${row.id}\`.\n\n${description}`;
        }),
      ].join("\n\n"),
    )
    .join("\n\n");
}

function batchTitle(rows: readonly ReportRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  const kinds = [...counts]
    .map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind))
    .join(", ");
  return rows.length === 1
    ? `Investigate report: ${renderReportTask(rows[0]!).title}`
    : `Investigate ${rows.length} reports: ${kinds}`;
}

/**
 * Report investigations: picks up the reports nobody has investigated that
 * are in scope (severity, recurrence, kind), files ONE task for the batch
 * under Reports, links every report in it to that task, and launches an agent
 * to find and fix the root cause. Off by default. Woken by each recorded report
 * (once the burst settles) or on a schedule, as its config says.
 */
export const reportInvestigationsAutomation = defineAutomation({
  id: REPORT_INVESTIGATIONS_ID,
  label: "Report investigations",
  icon: symbol("bug-report"),
  description:
    "Picks up reports nobody has investigated, files one task for the batch and launches an agent to find and fix the root cause.",
  categoryId: REPORTS_CATEGORY_ID,
  config: reportInvestigationsConfig,
  triggers: {
    kinds: ["event", "schedule"],
    eventLabel: "When a report is filed",
  },
  inProcess:
    "One indexed read of at most 20 uninvestigated reports, then at most one task insert and one update linking them — bounded by the batch cap; a restart simply leaves the reports for the next run.",
  promptVariables: [
    {
      name: "reports",
      description:
        "Every report in the batch, grouped by kind, each rendered as Investigate renders it",
    },
    { name: "count", description: "How many reports the batch holds" },
    { name: "kinds", description: "The report kinds in the batch" },
  ],
  detect: async ({ config }) => {
    const rows = await uninvestigatedReports({
      kinds: kindsInScope(config),
      minCount: config.minCount,
      limit: MAX_REPORTS_PER_TASK,
    });
    if (rows.length === 0) return null;
    const ids = rows.map((r) => r.id);
    return {
      title: batchTitle(rows),
      variables: {
        reports: reportsSection(rows),
        count: String(rows.length),
        kinds: [...new Set(rows.map((r) => r.kind))].join(", "),
      },
      sourceKeys: ids,
      onFiled: (taskId) => linkReportsToTask(ids, taskId),
    };
  },
});
