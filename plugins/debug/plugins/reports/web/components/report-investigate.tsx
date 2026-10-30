import { z } from "zod";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { reportsList, type Report } from "@plugins/reports/core";
import { investigate } from "@plugins/reports/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  InvestigateAction,
  type InvestigatePresentation,
} from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import type {
  NotificationActionControlProps,
  NotificationActionKind,
} from "@plugins/shell/plugins/notifications/web";

/**
 * Launch an agent on one report — the detail pane's Investigate and a report
 * notification's Fix are this one control. A report owns its own report → task
 * link (`report.taskId`, written by `investigate()`), so the action runs in
 * link mode: View task once linked.
 */
export function ReportInvestigate({
  report,
  presentation,
}: {
  report: Report;
  presentation: InvestigatePresentation;
}) {
  const fetchEndpoint = useFetchEndpoint();
  return (
    <InvestigateAction
      presentation={presentation}
      noun="report"
      linkedTaskId={report.taskId}
      draftKey={`report-investigate:${report.id}`}
      description={
        <>
          {report.kind}: {report.message}
        </>
      }
      placeholder="Extra context (optional) — e.g. what you were doing, expected behaviour…"
      resolve={async (userText) => {
        const answer = await investigate(fetchEndpoint, report.id);
        // Investigating needs the computer (`needsMachine`): a host without
        // it records no report to investigate, so this is not reached there
        // — said, if it ever is, never swallowed.
        if (answer.kind === "unavailable") throw new Error(answer.message);
        const { taskId } = answer.value;
        const parts: string[] = [];
        parts.push(`## Report (${report.kind})\n`);
        parts.push(`**Source:** ${report.source}`);
        parts.push(`**Message:** ${report.message}`);
        parts.push(
          `\n\`\`\`json\n${JSON.stringify(report.data, null, 2)}\n\`\`\``,
        );
        const extra = userText.trim();
        if (extra) {
          parts.push(`\n## Context\n\n${extra}`);
        }
        return { taskId, prompt: parts.join("\n") };
      }}
    />
  );
}

const FixPayloadSchema = z.object({ reportId: z.string() });

/**
 * A report notification's Fix (a crash, a slow op, …): the detail pane's
 * investigate launch, drawn as the notification's one action. Nothing until
 * the report is known (a notification outliving its report's row — retention
 * — offers no Fix: there is nothing left to brief an agent with).
 */
function ReportFixNotificationControl({
  payload,
  label,
}: NotificationActionControlProps) {
  const { reportId } = FixPayloadSchema.parse(payload);
  const read = useLiveRow(reportsList, reportId);
  if (read.status === "loading" || read.status === "error" || !read.found) {
    return null;
  }
  return (
    <ReportInvestigate
      report={read.row}
      presentation={{ notification: label }}
    />
  );
}

/** The `fix-report` notification action kind (`payload: { reportId }`). */
export const fixReportAction: NotificationActionKind = {
  kind: "fix-report",
  label: "Fix",
  Control: ReportFixNotificationControl,
};
