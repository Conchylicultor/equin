export { defineAuthProvider } from "./internal/lib";
export { oauthRedirectUri } from "./internal/redirect-uri";
export {
  oauthStart,
  oauthCallback,
  disconnect,
  setApiKey,
  signIn,
  getAuthState,
  getToken,
  DisconnectBodySchema,
  SetApiKeyBodySchema,
  SignInBodySchema,
  GetTokenBodySchema,
} from "./endpoints";
export type {
  DisconnectBody,
  SetApiKeyBody,
  SignInBody,
  GetTokenBody,
} from "./endpoints";
export type {
  AuthProviderDescriptor,
  AuthProviderKind,
  OAuth2Config,
  ApiKeyConfig,
  PasswordConfig,
  AuthIdentity,
  AuthAccountState,
  RefreshError,
  AuthStateValue,
  AuthEnvAccessor,
  ResolvedCredentials,
  ParsedTokenResponse,
} from "./internal/lib";
export {
  AuthError,
  AuthNeedsConsentError,
  AuthProviderUnknownError,
  AuthKeychainLockedError,
  AuthCredentialsMissingError,
} from "./internal/errors";
export { authState, AuthStateValueSchema } from "./resources";
export type {
  GetAccessTokenArgs,
  TokenResponse,
  TokenSuccess,
  TokenNeedsConsent,
  TokenFailure,
} from "./internal/token-types";
export {
  AuthRefreshFailedPayloadSchema,
  RefreshFailureKindSchema,
  TRANSIENT_REFRESH_REPORT_AFTER_MS,
  humanDuration,
} from "./internal/refresh-failure";
export type {
  AuthRefreshFailedPayload,
  RefreshFailureKind,
} from "./internal/refresh-failure";
export {
  AuthScopesLostPayloadSchema,
  ScopesLostDuringSchema,
  lostScopes,
  scopeLabel,
} from "./internal/scopes-lost";
export type {
  AuthScopesLostPayload,
  ScopesLostDuring,
} from "./internal/scopes-lost";
