import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { gatewayLogs } from "@plugins/infra/plugins/launcher/plugins/gateway-logs/data-dirs";
import {
  ServiceDownPayloadSchema,
  describeServiceDown,
  outageOf,
  upTimeOf,
  type ServiceDownPayload,
} from "../../core";

// The `service-down` kind, filed by the gateway's watchdog through the report
// outbox when a supervised service stops answering mid-session, once the
// outage settles. One row per service and outcome: a service that keeps
// dropping collapses onto one row whose `count` is how many times, and an
// outage it never came back from is its own row, not one more recovery.
// No cooldown raise: every outage failed every database connection on the
// machine, so a recurrence after a dismissal is news (the engine's floor
// applies).
export const serviceDownKind = ReportKind({
  kind: "service-down",
  schema: ServiceDownPayloadSchema,
  fingerprint: (d: ServiceDownPayload) =>
    `service-down:${d.service}:${d.outcome}`,
  meta: {
    tag: "[service-down]",
    notif: "Service went down",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = ServiceDownPayloadSchema.parse(row.data);
    return {
      title: `[service-down] ${describeServiceDown(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function fenced(lines: readonly string[]): string[] {
  return ["```", ...(lines.length > 0 ? lines : ["(nothing)"]), "```"];
}

function renderDescription(row: ReportRow, d: ServiceDownPayload): string {
  const up = upTimeOf(d);
  const lines: string[] = [];
  lines.push(`**${describeServiceDown(d)}**`);
  lines.push("");
  lines.push(
    `The gateway's watchdog found the supervised service \`${d.service}\` ` +
      `not answering its readiness probe (\`${d.probe}\`: ${d.probeError})` +
      `${up === null ? "" : ` after ${up} up`}. Every connection through it ` +
      `failed meanwhile — the backends' own errors are downstream of this. ` +
      (d.outcome === "recovered"
        ? `The watchdog ran its start command and it answered again ${outageOf(d)} later.`
        : `The watchdog ran its start command once and it failed, so the service ` +
          `is left \`crashed\` and is no longer watched: nothing restarts it until ` +
          `the gateway does (\`./equin start --force\`).`),
  );
  lines.push("");
  lines.push(
    "A probe failure is what was observed, not a cause: the start command's " +
      "output says whether the daemon was gone (a fresh start, a stale pidfile) " +
      "or still running (reattaching — then it was too slow to answer, not " +
      "dead), and the service's own log says why it went.",
  );
  lines.push("");
  if (d.restartError !== null) {
    lines.push("**Why the re-start failed:**");
    lines.push("");
    lines.push(...fenced(d.restartError.split("\n")));
    lines.push("");
  }
  lines.push("**What its start command said:**");
  lines.push("");
  lines.push(...fenced(d.restartOutput));
  lines.push("");
  lines.push(`**Its last log lines** (\`${d.logPath}\`, as of the detection):`);
  lines.push("");
  lines.push(
    ...(d.logTailError === null
      ? fenced(d.logTail)
      : [`The gateway could not read it: ${d.logTailError}`]),
  );
  lines.push("");
  lines.push(
    `**What to do:** read the log tail for the daemon's last words (Postgres ` +
      `logs its own fatal errors and a postmaster killed by a signal leaves ` +
      `none — then look for who sent it: \`log show --predicate 'process == "kernel"'\` ` +
      `for jetsam around ${new Date(d.detectedAt).toISOString()}). The ` +
      `gateway's \`gateway.log\` (\`${gatewayLogs.file("gateway.log")}\`) has ` +
      `the watchdog's own lines (\`watchdog detected service down\`).`,
  );
  lines.push("");
  lines.push(`**Service:** \`${d.service}\``);
  if (d.upSince !== null)
    lines.push(`**Up since:** ${new Date(d.upSince).toISOString()}`);
  lines.push(`**Detected:** ${new Date(d.detectedAt).toISOString()}`);
  lines.push(
    `**${d.outcome === "recovered" ? "Answering again" : "Marked crashed"}:** ${new Date(d.settledAt).toISOString()}`,
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
