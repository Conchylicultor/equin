import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  AuthRefreshFailedPayloadSchema,
  TRANSIENT_REFRESH_REPORT_AFTER_MS,
  humanDuration,
  type AuthRefreshFailedPayload,
} from "@plugins/auth/core";

// The `auth-refresh-failed` kind, filed by central's token refresh through the
// report outbox: a permanent refusal at once, a transient failure once it has
// lasted TRANSIENT_REFRESH_REPORT_AFTER_MS of awake time. One row per
// (provider, account, kind) — a run of failures, or the same refusal again
// after a reconnect, bumps `count` instead of opening a new row.
export const authRefreshFailedKind = ReportKind({
  kind: "auth-refresh-failed",
  schema: AuthRefreshFailedPayloadSchema,
  fingerprint: (d: AuthRefreshFailedPayload) =>
    `auth-refresh-failed:${d.providerId}:${d.accountId}:${d.kind}`,
  meta: {
    tag: "[auth-refresh-failed]",
    notif: "A connected account stopped refreshing",
    variant: "warning",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = AuthRefreshFailedPayloadSchema.parse(row.data);
    return {
      title:
        d.kind === "permanent"
          ? `[auth-refresh-failed] ${d.providerName} refused the token refresh`
          : `[auth-refresh-failed] ${d.providerName} token refresh failing for ${humanDuration(d.failingMs)}`,
      description: renderDescription(row, d),
    };
  },
});

function renderDescription(
  row: ReportRow,
  d: AuthRefreshFailedPayload,
): string {
  const what =
    d.kind === "permanent"
      ? `${d.providerName} refused to refresh the access token of account ` +
        `\`${d.accountId}\` (a 400/401 from its token endpoint: the grant was ` +
        `revoked or expired, or the OAuth client was deleted). The account is ` +
        `marked as needing reconsent; nothing that uses it works until the ` +
        `user reconnects it in Settings → Accounts.`
      : `Central has failed to refresh the access token of ${d.providerName} ` +
        `account \`${d.accountId}\` for **${humanDuration(d.failingMs)}** of ` +
        `awake time (machine sleep excluded), ${d.attempts} attempts, since ` +
        `${new Date(d.sinceMs).toISOString()}. It retries every minute, but ` +
        `the token has expired meanwhile, so every integration built on it ` +
        `(Gmail, …) has stopped working. Reported after ` +
        `${humanDuration(TRANSIENT_REFRESH_REPORT_AFTER_MS)} so the DNS blip ` +
        `after a wake stays quiet.`;
  return [
    what,
    "",
    `**What to do:** ${
      d.kind === "permanent"
        ? "reconnect the account; if it keeps being refused soon after connecting, read the hint and the provider's OAuth client setup."
        : "check whether the machine is online and the token endpoint answers; a 5xx or timeout that lasts is the provider's, an error from equin's own code (resolveCredentials, the token store) is a bug in `plugins/auth/central`."
    }`,
    "",
    `**Error:** ${d.error}`,
    ...(d.hint ? [`**Hint:** ${d.hint}`] : []),
    `**Kind:** ${d.kind}`,
    `**Sightings:** ${row.count}`,
    `**First seen:** ${row.firstSeenAt.toISOString()}`,
    `**Last seen:** ${row.lastSeenAt.toISOString()}`,
  ].join("\n");
}
