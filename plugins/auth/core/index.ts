export { defineAuthProvider } from "./internal/lib";
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
