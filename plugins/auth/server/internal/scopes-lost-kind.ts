import { ReportKind } from "@plugins/reports/server";
import type { ReportRow } from "@plugins/reports/server";
import {
  AuthScopesLostPayloadSchema,
  scopeLabel,
  type AuthScopesLostPayload,
} from "@plugins/auth/core";

// The `auth-scopes-lost` kind, filed by central whenever a write that replaces
// an account's scopes (a connect's callback, a token refresh) leaves it with
// fewer than it held — so a permission is never lost silently. One row per
// (provider, account): a repeat bumps `count`.
export const authScopesLostKind = ReportKind({
  kind: "auth-scopes-lost",
  schema: AuthScopesLostPayloadSchema,
  fingerprint: (d: AuthScopesLostPayload) =>
    `auth-scopes-lost:${d.providerId}:${d.accountId}`,
  meta: {
    tag: "[auth-scopes-lost]",
    notif: "A connected account lost permissions",
    variant: "warning",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = AuthScopesLostPayloadSchema.parse(row.data);
    const lost = d.lost.map(scopeLabel).join(", ");
    return {
      title: `[auth-scopes-lost] ${d.providerName} account lost ${lost}`,
      description: [
        d.during === "connect"
          ? `A (re)connect of ${d.providerName} account \`${d.accountId}\` was granted fewer permissions than the account held: **${lost}** went missing. Central asks for every held permission on each connect, so the user unticked them on the consent screen (or the provider refused them).`
          : `A token refresh of ${d.providerName} account \`${d.accountId}\` came back with fewer permissions than were stored: **${lost}** went missing. The provider narrowed the grant (revoked from the account's security settings, or an admin policy).`,
        "",
        "**What to do:** open Settings → Accounts → " +
          `${d.providerName} and use the feature's **Grant access** (or Reconnect, leaving every permission ticked).`,
        "",
        `**Lost:** ${d.lost.join(", ")}`,
        `**Granted now:** ${d.granted.join(", ")}`,
        `**Sightings:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});
