import type { EnvKey } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
/**
 * How a provider's credential is obtained. The closed list both runtimes read:
 * the descriptor type, the state resource's wire schema, and every `switch` on
 * a kind derive from it, so a new kind is a type error wherever it is unhandled.
 */
export const AUTH_PROVIDER_KINDS = ["oauth2", "apikey", "password"] as const;
export type AuthProviderKind = (typeof AUTH_PROVIDER_KINDS)[number];

export interface AuthIdentity {
  accountId: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

/** Reads one of the app's environment variables by key. */
export interface AuthEnvAccessor {
  get(key: EnvKey): string | undefined;
}

export interface ResolvedCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface ParsedTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
  idToken?: string;
}

export interface OAuth2Config {
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  scopeSeparator?: string;
  pkce?: boolean;
  buildAuthorizeParams?: (ctx: {
    scopes: string[];
    state: string;
    redirectUri: string;
    codeChallenge?: string;
  }) => Record<string, string>;
  parseTokenResponse?: (raw: unknown) => ParsedTokenResponse;
  fetchIdentity: (accessToken: string) => Promise<AuthIdentity>;
  revoke?: (args: {
    accessToken?: string;
    refreshToken?: string;
  }) => Promise<void>;
  resolveCredentials: (env: AuthEnvAccessor) => Promise<ResolvedCredentials>;
}

export interface ApiKeyConfig {
  pattern?: RegExp;
  help?: string;
  verify?: (apiKey: string) => Promise<AuthIdentity>;
}

/**
 * A provider that trades a username + password for a long-lived token. Central
 * calls `exchange` once, stores ONLY the returned token (as the account's static
 * credential, like an API key), and drops the password — it is never persisted
 * or logged. From then on the account behaves exactly like an api-key account.
 */
export interface PasswordConfig {
  // The dialog's wording (username label, sign-up link) is presentational and
  // lives on the provider's web `Auth.Provider` contribution (`passwordSignIn`)
  // — the browser cannot read a central descriptor.
  /**
   * Throws on a rejected sign-in, with the provider's own wording as the
   * message — it is shown to the user verbatim.
   */
  exchange: (creds: {
    username: string;
    password: string;
  }) => Promise<{ token: string; identity: AuthIdentity }>;
}

export interface AuthProviderDescriptor {
  id: string;
  name: string;
  kind: AuthProviderKind;
  oauth?: OAuth2Config;
  apiKey?: ApiKeyConfig;
  password?: PasswordConfig;
}

/**
 * The config branch each kind requires. A `Record` over every kind, so a new
 * kind with no branch named here is a type error, not a silently unchecked one.
 */
const CONFIG_FIELD = {
  oauth2: "oauth",
  apikey: "apiKey",
  password: "password",
} as const satisfies Record<AuthProviderKind, keyof AuthProviderDescriptor>;

/**
 * Identity helper. The descriptor is just data — this function is the
 * canonical way for provider plugins to construct one. Validates that the
 * `kind` matches the provided config branch.
 */
export function defineAuthProvider(
  descriptor: AuthProviderDescriptor,
): AuthProviderDescriptor {
  const field = CONFIG_FIELD[descriptor.kind];
  if (!descriptor[field]) {
    throw new Error(
      `defineAuthProvider("${descriptor.id}"): kind="${descriptor.kind}" requires .${field}`,
    );
  }
  if (!/^[a-z][a-z0-9-]*$/.test(descriptor.id)) {
    throw new Error(
      `defineAuthProvider("${descriptor.id}"): id must match /^[a-z][a-z0-9-]*$/`,
    );
  }
  return descriptor;
}

// ---------------------------------------------------------------------------
// State payload (broadcast to web clients via the auth-state live value).
// MUST NEVER include secret material (accessToken, refreshToken, apiKey).
// ---------------------------------------------------------------------------

export interface AuthAccountState {
  connected: boolean;
  kind: AuthProviderKind;
  credentialsConfigured: boolean;
  identity?: AuthIdentity;
  scopes?: string[];
  needsReconsent?: boolean;
  connectedAt?: number;
  lastRefreshError?: { message: string; at: number };
}

export interface AuthStateValue {
  mainOffline?: boolean;
  providers: { [providerId: string]: AuthAccountState };
}
