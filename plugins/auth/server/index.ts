import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { authRefreshFailedKind } from "./internal/refresh-failed-kind";
import { authScopesLostKind } from "./internal/scopes-lost-kind";

export {
  getTokenFromCentral,
  AuthCentralOfflineError,
} from "./internal/get-token";
export type {
  GetAccessTokenArgs,
  TokenResponse,
  TokenSuccess,
  TokenNeedsConsent,
  TokenFailure,
} from "@plugins/auth/core";

export default {
  description:
    "Worktree-side auth helpers. Provides getTokenFromCentral() for worktree plugins that need OAuth tokens. Registers the auth-refresh-failed report kind central's token refresh files through the report outbox: a refused grant at once, a transient failure once it has lasted 30 min of awake time. Registers the auth-scopes-lost report kind central files when a connect or refresh leaves an account with fewer permissions than it held.",
  contributions: [authRefreshFailedKind, authScopesLostKind],
} satisfies ServerPluginDefinition;
