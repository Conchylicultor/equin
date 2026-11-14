import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import {
  BackendCrashPayloadSchema,
  bunPanicOf,
  describeBackendCrash,
  macCrashReportGlob,
  uptimeOf,
  type BackendCrashPayload,
} from "../../core";

// The `backend-crash` kind, filed by the gateway through the report outbox
// when a backend dies by a signal it did not send. One row per worktree and
// signal: a backend that keeps segfaulting collapses onto one row whose
// `count` is how many times, each occurrence's evidence in its own payload.
// No cooldown raise: every crash killed every job and socket of that backend,
// so a recurrence after a dismissal is news (the engine's floor applies).
export const backendCrashKind = ReportKind({
  kind: "backend-crash",
  schema: BackendCrashPayloadSchema,
  fingerprint: (d: BackendCrashPayload) =>
    `backend-crash:${d.worktree}:${d.signal}`,
  meta: {
    tag: "[backend-crash]",
    notif: "Backend crashed",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = BackendCrashPayloadSchema.parse(row.data);
    return {
      title: `[backend-crash] ${describeBackendCrash(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: BackendCrashPayload): string {
  const { panic, reportUrl } = bunPanicOf(d);
  const lines: string[] = [];
  lines.push(`**${describeBackendCrash(d)}**`);
  lines.push("");
  lines.push(
    `The backend of \`${d.worktree}\` (pid ${d.pid}) was killed by **${d.signal}**` +
      `${d.coreDumped ? " (core dumped)" : ""} after ${uptimeOf(d)}, a signal ` +
      `the gateway did not send. A process killed by a signal runs none of its ` +
      `own handlers, so this report is the gateway's: it saw the death and held ` +
      `the process's stderr. The gateway restarts the backend on the next ` +
      `request; everything the dead one was doing — in-flight jobs (reclaimed ` +
      `after their lock times out), every tab's socket — died with it.`,
  );
  lines.push("");
  lines.push("**Evidence**");
  lines.push("");
  if (panic !== null) lines.push(`- Bun's crash handler: \`${panic}\``);
  if (reportUrl !== null)
    lines.push(
      `- bun.report (decodes frames in Bun's own binary only — a frame in a native addon or JIT code reads \`unknown\`): ${reportUrl}`,
    );
  lines.push(
    `- macOS crash report — every thread, every frame symbolized with its image (a native addon included): \`${macCrashReportGlob(d)}\` stamped near ${new Date(d.exitedAt).toISOString()} (local time in the name). Its \`faultingThread\` is the one that crashed.`,
  );
  lines.push(
    `- The gateway's log of this worktree's backends (\`${gatewayLogs.file(`${d.worktree}.log`)}\`), and its own \`gateway.log\` beside it (\`backend exited unexpectedly\`).`,
  );
  lines.push("");
  lines.push(
    `**Its last stderr lines**${d.stderrComplete ? "" : " (the pipe was still held open by another process, so this may be cut short)"}:`,
  );
  lines.push("");
  lines.push("```");
  lines.push(...(d.stderrTail.length > 0 ? d.stderrTail : ["(nothing)"]));
  lines.push("```");
  lines.push("");
  lines.push(
    `**What to do:** read the faulting thread in the macOS crash report first. A ` +
      `crash inside Bun's own code is a Bun bug — find what our code does to ` +
      `trigger it and file it upstream; a crash in a native addon's frames is ` +
      `that addon's bug (the 2026-11 main segfaults were @parcel/watcher's kqueue ` +
      `thread: research/2026-11-08-infra-main-segfaults-parcel-watcher.md).`,
  );
  lines.push("");
  lines.push(`**Worktree:** \`${d.worktree}\``);
  lines.push(`**Started:** ${new Date(d.startedAt).toISOString()}`);
  lines.push(`**Died:** ${new Date(d.exitedAt).toISOString()}`);
  lines.push(`**Signal:** ${d.signal} (${d.signalNumber})`);
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
