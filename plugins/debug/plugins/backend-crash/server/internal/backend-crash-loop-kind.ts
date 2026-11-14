import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import {
  BackendCrashLoopPayloadSchema,
  describeBackendCrashLoop,
  loopCausesOf,
  type BackendCrashLoopPayload,
} from "../../core";

// The `backend-crash-loop` kind: a worktree whose backend keeps dying, filed
// by the gateway on top of each death's own report (`backend-crash` /
// `backend-exit`) — at the threshold, each time the count doubles, and when
// it ends. One row per worktree: its `data` is the latest point of the latest
// loop, its `count` how many such points were filed. No cooldown raise.
export const backendCrashLoopKind = ReportKind({
  kind: "backend-crash-loop",
  schema: BackendCrashLoopPayloadSchema,
  fingerprint: (d: BackendCrashLoopPayload) =>
    `backend-crash-loop:${d.worktree}`,
  meta: {
    tag: "[backend-crash-loop]",
    notif: "Backend is crash-looping",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = BackendCrashLoopPayloadSchema.parse(row.data);
    return {
      title: `[backend-crash-loop] ${describeBackendCrashLoop(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: BackendCrashLoopPayload): string {
  const lines: string[] = [];
  lines.push(`**${describeBackendCrashLoop(d)}**`);
  lines.push("");
  lines.push(
    `The backend of \`${d.worktree}\` died **${d.deaths} times**, each death ` +
      `within ${formatDuration(d.windowMs)} of the one before ` +
      `(a loop from ${d.threshold} on), between ` +
      `${new Date(d.firstDeathAt).toISOString()} and ` +
      `${new Date(d.lastDeathAt).toISOString()}. Each time something asked for ` +
      `it again and the gateway respawned it. ` +
      (d.state === "looping"
        ? "As of this report it is still dying."
        : `No death followed for ${formatDuration(d.windowMs)}; its backend was then \`${d.stateAtEnd ?? "?"}\` (\`running\`: it stayed up; \`idle\` / \`broken\`: nothing restarted it).`),
  );
  lines.push("");
  lines.push(`**Causes (last ${d.recent.length} deaths):** ${loopCausesOf(d)}`);
  lines.push("");
  lines.push("| died at | cause | lived | was serving |");
  lines.push("| --- | --- | --- | --- |");
  for (const x of d.recent) {
    lines.push(
      `| ${new Date(x.at).toISOString()} | ${x.cause} | ${formatDuration(x.upMs)} | ${x.ready ? "yes" : "no (booting)"} |`,
    );
  }
  lines.push("");
  lines.push(
    `**The last death's stderr**${d.lastStderrComplete ? "" : " (may be cut short)"}:`,
  );
  lines.push("");
  lines.push("```");
  lines.push(
    ...(d.lastStderrTail.length > 0 ? d.lastStderrTail : ["(nothing)"]),
  );
  lines.push("```");
  lines.push("");
  lines.push(
    `**What to do:** each death has its own report (\`backend-exit\` for an ` +
      `exit code, \`backend-crash\` for a signal) with its own stderr; the ` +
      `error repeating across them is the cause. \`${gatewayLogs.file(`${d.worktree}.log`)}\` ` +
      `holds every boot's output, and \`gateway.log\`'s \`backend start requested\` ` +
      `lines say who kept respawning it.`,
  );
  lines.push("");
  lines.push(`**Points filed:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
