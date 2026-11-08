import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import {
  GatewayPanicPayloadSchema,
  describeGatewayPanic,
  type GatewayPanicPayload,
} from "../../core";

// The `gateway-panic` kind, filed by the gateway (handler_panic.go) through
// the report outbox when a request handler panics. One row per panic site: a
// storm of the same nil dereference is one row whose `count` grows (the
// gateway itself already folds a site's panics within a minute into one
// entry). No cooldown raise: a gateway handler panic is always a bug.
export const gatewayPanicKind = ReportKind({
  kind: "gateway-panic",
  schema: GatewayPanicPayloadSchema,
  fingerprint: (d: GatewayPanicPayload) => `gateway-panic:${d.site}`,
  meta: {
    tag: "[gateway-panic]",
    notif: "Gateway handler panicked",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = GatewayPanicPayloadSchema.parse(row.data);
    return {
      title: `[gateway-panic] ${describeGatewayPanic(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: GatewayPanicPayload): string {
  const lines: string[] = [];
  lines.push(`**${describeGatewayPanic(d)}**`);
  lines.push("");
  lines.push(
    `A request handler in the gateway (Go, \`gateway/\`) panicked in ` +
      `\`${d.site}\`: ${d.value}. The gateway recovered it — the request got a ` +
      `500 — and kept serving, but every request reaching the same code panics ` +
      `the same way: whatever that route serves is down while it lasts.`,
  );
  lines.push("");
  lines.push(
    `**Request:** \`${d.method} ${d.host}${d.path}\`` +
      (d.count > 1 ? ` (the latest of ${d.count} at this site)` : ""),
  );
  lines.push(`**First:** ${new Date(d.firstAt).toISOString()}`);
  lines.push(`**Last:** ${new Date(d.lastAt).toISOString()}`);
  lines.push("");
  lines.push("**Stack** (from the panic down):");
  lines.push("");
  lines.push("```", ...(d.stack.length > 0 ? d.stack : ["(none)"]), "```");
  lines.push("");
  lines.push(
    `**What to do:** the stack names the line. Reproduce it in a Go test in ` +
      `\`gateway/\` first. The gateway's own log (\`${gatewayLogs.file("gateway.log")}\`) ` +
      `has every panic at error (\`gateway handler panicked\`). A fix takes ` +
      `effect only once the gateway is restarted (\`./equin start --force\`).`,
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
