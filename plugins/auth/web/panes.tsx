import {
  Pane,
  PaneChrome,
  defineRoute,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { AccountsPane } from "./components/accounts-pane";
import { AccountDetail } from "./components/account-detail";
import { Auth } from "./slots";

/**
 * Deliberately NOT exported. The only pane chained off Accounts is
 * `accountPane` below, which renders whatever a row contributes (a provider's
 * setup, an integration's) — so a setup pane reachable from a link but missing
 * from the list cannot be spelled: there is no route to hang it off.
 */
const accountsRoute = defineRoute({
  id: "accounts",
  segment: "accounts",
});

export const accountsPane = Pane.define({
  route: accountsRoute,
  app: settingsApp,
  component: AccountsPane,
  title: "Accounts",
  chrome: { history: true },
  width: 420,
});

/** The row's name, from its provider or integration contribution. */
function useAccountTitle({
  accountId,
}: {
  accountId: string;
}): string | undefined {
  const providers = Auth.Provider.useContributions();
  const integrations = Auth.Integration.useContributions();
  return (
    providers.find((p) => p.id === accountId)?.name ??
    integrations.find((i) => i.id === accountId)?.name
  );
}

/** An account exists when a plugin contributes it — plugin contributions are known synchronously. */
function useResolveAccount({
  accountId,
}: {
  accountId: string;
}): ResolveResult {
  const providers = Auth.Provider.useContributions();
  const integrations = Auth.Integration.useContributions();
  return providers.some((p) => p.id === accountId) ||
    integrations.some((i) => i.id === accountId)
    ? { status: "found" }
    : { status: "missing" };
}

// /settings/accounts/account/<id>: one Accounts row — a provider or an
// integration — with its status, its account and its setup, in one pane.
// Consumers that send the user to set something up link here by id.
export const accountPane = Pane.define({
  route: defineRoute({
    id: "accounts-account",
    segment: "account/:accountId",
    parent: accountsRoute,
  }),
  app: settingsApp,
  component: AccountBody,
  useResolve: useResolveAccount,
  title: { useText: useAccountTitle, fallback: "Account" },
  width: 560,
});

function AccountBody() {
  const { accountId } = accountPane.useParams();
  return (
    <PaneChrome pane={accountPane}>
      <AccountDetail accountId={accountId} />
    </PaneChrome>
  );
}
