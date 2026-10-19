import { accountsPane, accountPane } from "./panes";
import { Auth } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Auth } from "./slots";
export type {
  AuthProviderContribution,
  AuthIntegrationContribution,
  AuthScopeRequirement,
  IntegrationStatus,
} from "./slots";
export { accountsPane, accountPane } from "./panes";
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
    "Shared authentication infrastructure (OAuth 2.0, API keys, password sign-in). Exposes the Accounts pane — a DataView of every provider (Auth.Provider) and non-provider setup surface (Auth.Integration), grouped by service, each row opening one account pane to the right (header, account, and the row's setup inline — a provider's setup wizard, OAuth client steps or sign-in form; an integration's own setup) — and the Settings app surfaces the Account entry.",
  loadBearing: true,
  contributions: [],
  slots: {
    ...Auth,
    accounts: accountsPane,
    "accounts-account": accountPane,
  },
} satisfies PluginDefinition;
