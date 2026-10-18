import {
  Pane,
  PaneChrome,
  defineRoute,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { AccountsPane } from "./components/accounts-pane";
import { ProviderDetail } from "./components/provider-detail";
import { Auth } from "./slots";

/**
 * Exported because every pane an Accounts row opens — the provider pane here,
 * an integration's own pane, the setup wizards (Google, Google Maps, Apple
 * signing) — chains off this route.
 *
 * It stays in `web/` rather than moving to `core/`, even though `auth/core`
 * exists: `auth/plugins/google/web` already imports its own setup wizard, and a
 * `core`-tagged edge back from that wizard to `auth` is folded into the server
 * and central cycle graphs where a `web`-tagged one is not. Nothing server-side
 * needs to build this link, so there is nothing to buy by promoting it.
 */
export const accountsRoute = defineRoute({
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

/** The provider's name, from its web contribution. */
function useProviderTitle({
  providerId,
}: {
  providerId: string;
}): string | undefined {
  return Auth.Provider.useContributions().find((p) => p.id === providerId)
    ?.name;
}

/** A provider exists when a plugin contributes it — plugin contributions are known synchronously. */
function useResolveProvider({
  providerId,
}: {
  providerId: string;
}): ResolveResult {
  return Auth.Provider.useContributions().some((p) => p.id === providerId)
    ? { status: "found" }
    : { status: "missing" };
}

// /settings/accounts/provider/<id>: one auth provider — its account and the
// buttons that connect, set up or disconnect it.
export const providerPane = Pane.define({
  route: defineRoute({
    id: "accounts-provider",
    segment: "provider/:providerId",
    parent: accountsRoute,
  }),
  app: settingsApp,
  component: ProviderBody,
  useResolve: useResolveProvider,
  title: { useText: useProviderTitle, fallback: "Account" },
  width: 520,
});

function ProviderBody() {
  const { providerId } = providerPane.useParams();
  return (
    <PaneChrome pane={providerPane}>
      <ProviderDetail providerId={providerId} />
    </PaneChrome>
  );
}
