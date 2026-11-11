import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  GatewayRestartFailedPayloadSchema,
  describeGatewayRestartFailed,
  type GatewayRestartFailedPayload,
} from "../../core";

// The `gateway-restart-failed` kind, filed through the report outbox by main's
// convergence run when its follow-main step could not bring the machine's
// gateway onto main's (gateway-drift/cli). Written by that run and not by the
// gateway: the gateway that started the run is the one it replaced. One
// standing row — while it stands, gateway changes on main are not running.
export const gatewayRestartFailedKind = ReportKind({
  kind: "gateway-restart-failed",
  schema: GatewayRestartFailedPayloadSchema,
  fingerprint: () => "gateway-restart-failed",
  meta: {
    tag: "[gateway-restart-failed]",
    notif: "Main's gateway could not be restarted",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = GatewayRestartFailedPayloadSchema.parse(row.data);
    return {
      title: `[gateway-restart-failed] ${describeGatewayRestartFailed(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(
  row: ReportRow,
  d: GatewayRestartFailedPayload,
): string {
  const lines: string[] = [];
  lines.push(`**${describeGatewayRestartFailed(d)}**`);
  lines.push("");
  lines.push(
    "After every build, main's convergence run (`./equin build --allow-main --converge`) " +
      "brings the machine's gateway onto main's: when the installed gateway differs from what " +
      "`./equin start --force` would install, it installs main's, reloads the login service and " +
      "waits for it to listen — and when it does not, it reinstalls the previous build and its " +
      "exact job definition. Nothing retries the same launch: the next push that changes the " +
      "gateway is the next try. The health report's Gateway row stays Out of date meanwhile.",
  );
  lines.push("");
  lines.push(`**Installing:** \`${d.to}\` (was \`${d.from ?? "unknown"}\`)`);
  lines.push(`**Because:** ${d.differences.join("; ") || "(none recorded)"}`);
  lines.push(
    `**Rollback:** ${d.rollback.kind === "restored" ? `restored (PID ${d.rollback.pid ?? "unknown"})` : d.rollback.kind}`,
  );
  lines.push(`**Checkout:** \`${d.checkout}\``);
  lines.push(`**At:** ${new Date(d.at).toISOString()}`);
  lines.push("");
  lines.push("**Error:**", "", "```", ...d.error, "```");
  if (d.rollback.kind === "failed") {
    lines.push(
      "",
      "**Rollback error:**",
      "",
      "```",
      ...d.rollback.error,
      "```",
    );
  }
  lines.push("");
  lines.push(
    `**What to do:** read \`${gatewayLogs.file("gateway-stdio.log")}\` and \`${gatewayLogs.file("gateway.log")}\` for the ` +
      "new gateway's own failure, fix it on main, and push; or run `./equin start --force` by " +
      `hand once fixed. The full run is in \`${gatewayLogs.file("deploy", "main.log")}\`.`,
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
