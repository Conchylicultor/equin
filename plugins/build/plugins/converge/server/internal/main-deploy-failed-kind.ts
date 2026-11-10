import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  MainDeployFailedPayloadSchema,
  describeMainDeployFailed,
  type MainDeployFailedPayload,
} from "../../core";

// The `main-deploy-failed` kind, filed by the gateway (main_deploy.go) through
// the report outbox when main's convergence run fails — not a BUILD that
// failed (that is the build's own row and bell), the run that decides and
// starts builds. One standing row: while it keeps failing, no push reaches
// main without a person, which is exactly the state the run exists to end.
export const mainDeployFailedKind = ReportKind({
  kind: "main-deploy-failed",
  schema: MainDeployFailedPayloadSchema,
  fingerprint: () => "main-deploy-failed",
  meta: {
    tag: "[main-deploy-failed]",
    notif: "Main's auto-deploy failed",
    variant: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = MainDeployFailedPayloadSchema.parse(row.data);
    return {
      title: `[main-deploy-failed] ${describeMainDeployFailed(d)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: MainDeployFailedPayload): string {
  const lines: string[] = [];
  lines.push(`**${describeMainDeployFailed(d)}**`);
  lines.push("");
  lines.push(
    "The gateway starts `./equin build --allow-main --converge` in main's checkout on every " +
      "advance of `refs/heads/main`, on its own boot, and when a backend asks. That run decides " +
      "whether main (or a served composition) is behind a commit it has not attempted and builds " +
      "it. This one failed before it could say the deployment is converged — so a push to main " +
      "may not have been deployed. A failed BUILD is not this report: it ends the run normally " +
      "and is in the build history.",
  );
  lines.push("");
  if (d.spawnError !== null) lines.push(`**Could not start:** ${d.spawnError}`);
  else if (d.signal !== null) lines.push(`**Ended by:** ${d.signal}`);
  else lines.push(`**Exit status:** ${d.exitCode}`);
  lines.push(`**Started by:** ${d.causes.join(", ") || "(unknown)"}`);
  lines.push(
    `**Ran:** ${new Date(d.startedAt).toISOString()} → ${new Date(d.endedAt).toISOString()}`,
  );
  lines.push(`**Checkout:** \`${d.checkout}\``);
  lines.push("");
  lines.push(`**Last lines** (the whole run: \`${d.log}\`):`);
  lines.push("");
  lines.push("```", ...(d.tail.length > 0 ? d.tail : ["(none)"]), "```");
  lines.push("");
  lines.push(
    "**What to do:** reproduce it from main's checkout with " +
      "`./equin build --allow-main --converge` (it builds only what auto-build would). " +
      "The next push or gateway boot runs it again; nothing retries it in between.",
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return lines.join("\n");
}
