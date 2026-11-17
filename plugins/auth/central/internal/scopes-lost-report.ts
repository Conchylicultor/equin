import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";
import {
  lostScopes,
  scopeLabel,
  type ScopesLostDuring,
} from "@plugins/auth/core";

/**
 * Every write that REPLACES an account's scopes (a connect's callback, a
 * refresh) goes through here: when the new set is narrower than the one the
 * account held, the loss is filed as an `auth-scopes-lost` report (kind
 * registered by auth/server) instead of passing silently. Returns the lost
 * scopes, so a connect can also say so on its result page.
 */
export async function reportScopesIfLost(args: {
  providerId: string;
  providerName: string;
  accountId: string;
  during: ScopesLostDuring;
  held: string[] | undefined;
  granted: string[];
}): Promise<string[]> {
  const lost = lostScopes(args.held ?? [], args.granted);
  if (lost.length === 0) return lost;
  const message = `${args.providerName} account lost ${lost.length} permission${
    lost.length === 1 ? "" : "s"
  } on ${args.during}: ${lost.map(scopeLabel).join(", ")}`;
  console.warn(`[auth] ${message}`);
  const result = await fileReportFromProcess({
    kind: "auth-scopes-lost",
    message,
    data: {
      providerId: args.providerId,
      providerName: args.providerName,
      accountId: args.accountId,
      during: args.during,
      lost,
      granted: args.granted,
    },
  });
  if (result.outcome !== "written")
    console.error(
      `[auth] could not file the scopes-lost report (${result.outcome}): ${message}`,
    );
  return lost;
}
