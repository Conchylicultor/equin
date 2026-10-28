import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";
import { handleOAuthStart } from "./internal/handlers/oauth-start";
import { handleOAuthCallback } from "./internal/handlers/oauth-callback";
import { handleDisconnect } from "./internal/handlers/disconnect";
import { handleSetApiKey } from "./internal/handlers/api-key";
import { handleSignIn } from "./internal/handlers/sign-in";
import { handleGetState } from "./internal/handlers/state";
import { handleGetToken } from "./internal/handlers/token";
import { authStateServed } from "./internal/auth-resource";
import { onReady } from "./internal/boot";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/core";
import { authRefreshTimer } from "./internal/refresh-loop";
import {
  oauthStart,
  oauthCallback,
  disconnect,
  setApiKey,
  signIn,
  getAuthState,
  getToken,
} from "@plugins/auth/core";

export {
  getAccessToken,
  getAccountIdentity,
  listProviders,
} from "./internal/token-access";
export { registerAuthProvider } from "./internal/registry";
export { authStateServed } from "./internal/auth-resource";
export { defineAuthProvider } from "@plugins/auth/core";
export type {
  AuthIdentity,
  AuthProviderDescriptor,
  AuthProviderKind,
  AuthStateValue,
  AuthAccountState,
  OAuth2Config,
  ApiKeyConfig,
  PasswordConfig,
  ResolvedCredentials,
  ParsedTokenResponse,
  AuthEnvAccessor,
  GetAccessTokenArgs,
  TokenResponse,
  TokenSuccess,
  TokenNeedsConsent,
  TokenFailure,
} from "@plugins/auth/core";
export {
  AuthError,
  AuthNeedsConsentError,
  AuthProviderUnknownError,
  AuthCredentialsMissingError,
  AuthKeychainLockedError,
} from "@plugins/auth/core";

export default {
  description:
    "Centralized OAuth/API-key/password-sign-in infrastructure for third-party services. Tokens persist via the central secrets store; auth runs on the central runtime so all worktrees share one connected state.",
  httpRoutes: {
    // Raw (HTML / redirects), behind their declarations: the callback's
    // `access: { public }` must ride on its handler for the principal gate.
    [oauthStart.route]: rawEndpointHandler(oauthStart, handleOAuthStart),
    [oauthCallback.route]: rawEndpointHandler(
      oauthCallback,
      handleOAuthCallback,
    ),
    [disconnect.route]: handleDisconnect,
    [setApiKey.route]: handleSetApiKey,
    [signIn.route]: handleSignIn,
    [getAuthState.route]: handleGetState,
    [getToken.route]: handleGetToken,
  },
  resources: [authStateServed],
  register: [authRefreshTimer],
  onReady,
} satisfies CentralPluginDefinition;
