import type { BoundaryErrorReport } from "@plugins/primitives/plugins/error-boundary/web";
import { serializeUiContext } from "@plugins/primitives/plugins/ui-context/core";
import type { ReportContext } from "@plugins/reports/web";
import { investigate } from "@plugins/reports/web";
import { investigateReport } from "@plugins/reports/core";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoFixHighIcon = symbol("auto-fix-high");

export function LaunchFixButton({
  report,
  context,
}: {
  report: BoundaryErrorReport;
  context: unknown;
}) {
  // Reports no longer auto-create a task, so the Fix button investigates the
  // recorded crash report on demand: it creates (or reuses) the investigation
  // task at launch time, then launches a conversation bound to it.
  const reportId = (context as ReportContext | null)?.reportId ?? null;
  // Investigating files a task for an agent on the computer: a host without
  // it (the demo's worker) says so instead of offering the button.
  const availability = useMachineAvailability(investigateReport);
  const disabled = reportId === null || !availability.available;
  const fetchEndpoint = useFetchEndpoint();

  return (
    <LaunchAgentPopover
      // Not the report id: it is still null while the crash is being recorded,
      // and the draft must not move when it arrives.
      draftKey={`crash-fix:${report.slot}:${report.label}:${report.error.message}`}
      trigger={
        <button
          title={
            !availability.available
              ? availability.message
              : reportId === null
                ? "Recording crash…"
                : "Launch an agent to fix this crash"
          }
          aria-label="Launch fix agent"
          disabled={disabled}
          className="rounded-md px-xs py-2xs underline hover:no-underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
        >
          <Stack as="span" direction="row" gap="xs" align="center">
            <Icon icon={autoFixHighIcon} className="size-3" />
            Fix
          </Stack>
        </button>
      }
      title="Fix this crash"
      description={
        <>
          {[report.slot, report.label].filter(Boolean).join(" / ") || "Plugin"}{" "}
          crashed: {report.error.message}
        </>
      }
      placeholder="Extra context (optional) — e.g. what you were doing, expected behaviour…"
      align="end"
      disabled={disabled}
      getRequest={async (userText) => {
        // Investigate first so the launched conversation is bound to the report's
        // task (idempotent server-side: re-clicking reuses the existing task).
        // A null reportId can't reach here — the trigger is disabled.
        const answer = await investigate(fetchEndpoint, reportId!);
        // The trigger is disabled without the computer, so this is a broken
        // assumption if reached — said, not swallowed.
        if (answer.kind === "unavailable") throw new Error(answer.message);
        const { taskId } = answer.value;
        const parts: string[] = [];
        parts.push(`## Crash report\n`);
        if (report.slot || report.label) {
          parts.push(
            `**Location:** ${[report.slot, report.label].filter(Boolean).join(" / ")}`,
          );
        }
        // The prompt is built here from the LIVE report — it never reads back the
        // persisted row — so the lineage token has to be emitted a second time,
        // beside the crash task's own copy.
        if (report.uiContext) {
          parts.push(serializeUiContext(report.uiContext, "crash"));
        }
        parts.push(`**Error:** ${report.error.message}`);
        if (report.error.stack) {
          parts.push(`\n\`\`\`\n${report.error.stack}\n\`\`\``);
        }
        if (report.componentStack) {
          parts.push(
            `\n**Component stack:**\n\`\`\`\n${report.componentStack.trim()}\n\`\`\``,
          );
        }
        const extra = userText.trim();
        if (extra) {
          parts.push(`\n## Context\n\n${extra}`);
        }
        return {
          taskId,
          prompt: parts.join("\n"),
        };
      }}
    />
  );
}
