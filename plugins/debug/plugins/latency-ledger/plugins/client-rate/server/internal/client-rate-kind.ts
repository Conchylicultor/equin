import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import { ClientRatePayloadSchema, type ClientRatePayload } from "../../core";
import { appOfRoute } from "./client-rate-baseline";

// A runaway client is a persistent condition (it keeps reloading tick after
// tick): re-surface it at most every 10 minutes, as op-rate does.
const NOTIF_COOLDOWN_MS = 600_000;

const NOUN = {
  "page-load": "page loads",
  navigate: "in-app navigations",
} as const;

// The `client-rate` report kind: one browser tab loading pages (or navigating)
// far more often in an hour than a client usually does. Grouped by what it
// does and the app it does it in, not by tab: the same loop restarted in a
// fresh tab (a new tab id) lands on the same report.
export const clientRateKind = ReportKind({
  kind: "client-rate",
  schema: ClientRatePayloadSchema,
  fingerprint: (d: ClientRatePayload) =>
    `client-rate:${d.interaction}:${appOfRoute(d.route)}`,
  meta: {
    tag: "[client-rate]",
    notif: "A browser tab is reloading in a loop",
    variant: "warning",
    category: "slow-op",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = ClientRatePayloadSchema.parse(row.data);
    return {
      title: `[client-rate] ${d.route} — ${d.count} ${NOUN[d.interaction]} in an hour from one ${d.automated ? "automated " : ""}tab`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(row: ReportRow, d: ClientRatePayload): string {
  const lines = [
    `One browser tab (\`${d.clientId}\`${d.automated ? ", driven by automation — `navigator.webdriver`: the agent browser or an e2e run" : ""}) ` +
      `made **${d.count}** ${NOUN[d.interaction]} of \`${d.route}\` in the clock hour starting ${d.hourStart}, ` +
      `where a client usually loads one route at most ${d.usual} times in an hour (the 99th ` +
      `percentile of the ${d.historyClientHours} client-route-hours of the last 7 days) — past the ` +
      `threshold of ${d.threshold}. A reload or redirect loop is spread thin across ` +
      "ops, so no call-count alarm sees it; find what keeps reloading this tab.",
    "",
    "**Everywhere this tab went this hour:**",
    ...d.topRoutes.map((r) => `- \`${r.route}\` ×${r.count}`),
    "",
    "The rows are in `latency_ledger_interaction` (`client_id`).",
    "",
    `**Occurrences:** ${row.count}`,
    `**Worktree:** ${row.worktree}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ];
  return lines.join("\n");
}
