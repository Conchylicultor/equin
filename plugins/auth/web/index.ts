import { accountsPane, providerPane } from "./panes";
import { Auth } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Auth } from "./slots";
export type {
  AuthProviderContribution,
  AuthIntegrationContribution,
  AuthScopeRequirement,
  IntegrationStatus,
} from "./slots";
export { accountsPane, accountsRoute, providerPane } from "./panes";
export { useAuthState, useAccountStatus } from "./hooks";
export { ConnectButton } from "./components/connect-button";
export { GrantAccessButton } from "./components/grant-access-button";
export type { ConnectButtonProps } from "./components/connect-button";
export { startConnectFlow, disconnect, currentWorktreeName } from "./connect";
export type { ConnectArgs, ConnectResult } from "./connect";
export { missingScopes } from "./scopes";

export default {
  collapsed: true,
  description:
    "Shared authentication infrastructure (OAuth 2.0, API keys, password sign-in). Exposes the Accounts pane — a DataView of every provider (Auth.Provider) and non-provider setup surface (Auth.Integration), grouped by service, each row opening its pane to the right (the provider pane, or the integration's own) — and the Settings app surfaces the Account entry.",
  loadBearing: true,
  contributions: [],
  slots: {
    ...Auth,
    accounts: accountsPane,
    "accounts-provider": providerPane,
  },
} satisfies PluginDefinition;
