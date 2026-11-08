import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import {
  BackendExitPayloadSchema,
  describeBackendExit,
  exitErrorLineOf,
  type BackendExitPayload,
} from "../../core";

// The `backend-exit` kind, filed by the gateway through the report outbox
// when a backend exits by code and nobody asked it to. One row per worktree
// and exit code: a backend that keeps exiting collapses onto one row whose
// `count` is how many times; a worktree that keeps dying is ALSO a
// `backend-crash-loop` row (backend-crash-loop-kind.ts), the summary on top.
// No cooldown raise (the engine's floor applies): every exit killed every job
// and socket of that backend.
export const backendExitKind = ReportKind({
  kind: "backend-exit",
  schema: BackendExitPayloadSchema,
  fingerprint: (d: BackendExitPayload) =>
    `backend-exit:${d.worktree}:${d.exitCode}`,
  meta: {
    tag: "[backend-exit]",
    notif: "Backend exited",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = BackendExitPayloadSchema.parse(row.data);
    return {
      title: `[backend-exit] ${describeBackendExit(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: BackendExitPayload): string {
  const errorLine = exitErrorLineOf(d);
  const lines: string[] = [];
  lines.push(`**${describeBackendExit(d)}**`);
  lines.push("");
  lines.push(
    `The backend of \`${d.worktree}\` (pid ${d.pid}) exited with code ` +
      `**${d.exitCode}** without the gateway asking it to (no stop, drain or ` +
      `deadline kill). The process may also have filed its own report of the ` +
      `error it died of — but a process that dies at boot, or whose report has ` +
      `to reach the database it is failing on, often cannot, so the gateway ` +
      `files the death itself. The gateway respawns it on the next request; ` +
      `everything it was doing — in-flight jobs, every tab's socket — died with it.`,
  );
  lines.push("");
  if (errorLine !== null) {
    lines.push(`**What it said last:** \`${errorLine}\``);
    lines.push("");
  }
  lines.push(
    `**Its last stderr lines**${d.stderrComplete ? "" : " (the pipe was still held open by another process, so this may be cut short)"}:`,
  );
  lines.push("");
  lines.push("```");
  lines.push(...(d.stderrTail.length > 0 ? d.stderrTail : ["(nothing)"]));
  lines.push("```");
  lines.push("");
  lines.push(
    `**Where to look:** the gateway's log of this worktree's backends ` +
      `(\`${gatewayLogs.file(`${d.worktree}.log`)}\`, the full stderr before ` +
      `the tail) and \`gateway.log\` beside it (\`backend exited unexpectedly\`, ` +
      `and \`backend start requested\` — who keeps respawning it). A ` +
      `\`backend-crash-loop\` report says whether it keeps dying.`,
  );
  lines.push("");
  lines.push(`**Worktree:** \`${d.worktree}\``);
  lines.push(`**Started:** ${new Date(d.startedAt).toISOString()}`);
  lines.push(
    `**Ready:** ${d.readyAt === null ? "never (died booting)" : new Date(d.readyAt).toISOString()}`,
  );
  lines.push(`**Exited:** ${new Date(d.exitedAt).toISOString()}`);
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
