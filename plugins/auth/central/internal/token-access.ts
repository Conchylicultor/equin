import { getProvider, listProviders } from "./registry";
import { getAccount, patchAccount, type StoredAccount } from "./token-store";
import { resolveCredentials } from "./credentials";
import { refreshAccessToken } from "./oauth-flow";
import type { AuthIdentity, AuthProviderDescriptor } from "@plugins/auth/core";
import { AuthNeedsConsentError } from "@plugins/auth/core";
import type { GetAccessTokenArgs, TokenResponse } from "@plugins/auth/core";

const REFRESH_LEAD_MS = 60_000;
const inFlightRefreshes = new Map<string, Promise<StoredAccount>>();

function refreshKey(providerId: string, accountId: string): string {
  return `${providerId}::${accountId}`;
}

function scopeSubset(requested: string[], stored: string[]): boolean {
  const set = new Set(stored);
  return requested.every((s) => set.has(s));
}

async function refreshAccount(
  descriptor: AuthProviderDescriptor,
  accountId: string,
  account: StoredAccount,
): Promise<StoredAccount> {
  const key = refreshKey(descriptor.id, accountId);
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const promise = (async () => {
    if (!descriptor.oauth || !account.refreshToken) {
      throw new AuthNeedsConsentError({
        providerId: descriptor.id,
        reason: "needs-reconsent",
      });
    }
    try {
      const creds = await resolveCredentials(descriptor);
      const refreshed = await refreshAccessToken({
        oauth: descriptor.oauth,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: account.refreshToken,
      });
      const updated = await patchAccount(descriptor.id, accountId, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        scopes: refreshed.scopes ?? account.scopes,
        idToken: refreshed.idToken ?? account.idToken,
        lastRefreshedAt: Date.now(),
        needsReconsent: false,
        lastRefreshError: undefined,
      });
      return updated ?? account;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 400 || status === 401) {
        const at = Date.now();
        const hint = descriptor.oauth.diagnoseRefreshFailure?.({
          responseText: (err as { responseText?: string }).responseText ?? "",
          grantAgeMs: at - account.connectedAt,
        });
        await patchAccount(descriptor.id, accountId, {
          needsReconsent: true,
          accessToken: undefined,
          expiresAt: undefined,
          lastRefreshError: {
            message: err instanceof Error ? err.message : String(err),
            at,
            hint,
          },
        });
        throw new AuthNeedsConsentError({
          providerId: descriptor.id,
          reason: "needs-reconsent",
          hint,
        });
      }
      await patchAccount(descriptor.id, accountId, {
        lastRefreshError: {
          message: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        },
      });
      throw err;
    }
  })();
  inFlightRefreshes.set(key, promise);
  // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- bookkeeping handler attached to an already-detached refresh promise; no new main-thread work to attribute
  void promise.finally(() => inFlightRefreshes.delete(key));
  return promise;
}

export type {
  GetAccessTokenArgs,
  TokenResponse,
  TokenSuccess,
  TokenNeedsConsent,
  TokenFailure,
} from "@plugins/auth/core";

/** Token resolver. Returns a structured TokenResponse. */
export async function getAccessTokenInternal(
  args: GetAccessTokenArgs,
): Promise<TokenResponse> {
  const accountId = args.accountId ?? "primary";
  let descriptor: AuthProviderDescriptor;
  try {
    descriptor = getProvider(args.providerId);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      code: "unknown-provider",
    };
  }

  const account = getAccount(args.providerId, accountId);
  if (!account) {
    return {
      ok: false,
      needsConsent: true,
      reason: "no-account",
    };
  }
  if (account.needsReconsent) {
    return {
      ok: false,
      needsConsent: true,
      reason: "needs-reconsent",
      hint: account.lastRefreshError?.hint,
    };
  }

  switch (account.kind) {
    // A static credential: an API key stored as pasted, or the long-lived token
    // a password sign-in traded for. Neither expires nor carries scopes.
    case "apikey":
    case "password":
      if (!account.apiKey) {
        return {
          ok: false,
          needsConsent: true,
          reason: "no-account",
        };
      }
      return {
        ok: true,
        accessToken: account.apiKey,
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: [],
        identity: account.identity,
      };
    case "oauth2":
      break;
    default: {
      const unknownKind: never = account.kind;
      throw new Error(
        `auth: account "${args.providerId}/${accountId}" has unknown kind "${String(unknownKind)}"`,
      );
    }
  }

  if (args.scopes && args.scopes.length > 0) {
    const stored = account.scopes ?? [];
    if (!scopeSubset(args.scopes, stored)) {
      return {
        ok: false,
        needsConsent: true,
        reason: "missing-scopes",
        missingScopes: args.scopes.filter((s) => !stored.includes(s)),
      };
    }
  }

  const expiresAt = account.expiresAt ?? 0;
  if (account.accessToken && expiresAt > Date.now() + REFRESH_LEAD_MS) {
    return {
      ok: true,
      accessToken: account.accessToken,
      expiresAt,
      scopes: account.scopes ?? [],
      identity: account.identity,
    };
  }

  // Need a refresh.
  try {
    const refreshed = await refreshAccount(descriptor, accountId, account);
    if (!refreshed.accessToken || !refreshed.expiresAt) {
      return {
        ok: false,
        needsConsent: true,
        reason: "needs-reconsent",
      };
    }
    return {
      ok: true,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      scopes: refreshed.scopes ?? [],
      identity: refreshed.identity,
    };
  } catch (err) {
    if (err instanceof AuthNeedsConsentError) {
      return {
        ok: false,
        needsConsent: true,
        reason: err.reason,
        missingScopes: err.missingScopes,
        hint: err.hint,
      };
    }
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Public consumer API. Throws AuthNeedsConsentError or generic Error for
 * non-consent failures. In-process callers (other central plugins) await this
 * and use the returned access token to make their own provider requests.
 */
export async function getAccessToken(args: GetAccessTokenArgs): Promise<{
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  identity: AuthIdentity;
}> {
  const result = await getAccessTokenInternal(args);

  if (result.ok) {
    return {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      scopes: result.scopes,
      identity: result.identity,
    };
  }
  if (result.needsConsent) {
    throw new AuthNeedsConsentError({
      providerId: args.providerId,
      reason: result.reason,
      missingScopes: result.missingScopes,
      hint: result.hint,
    });
  }
  throw new Error(result.message);
}

export async function getAccountIdentity(
  providerId: string,
  accountId = "primary",
): Promise<AuthIdentity | undefined> {
  const account = getAccount(providerId, accountId);
  return account?.identity;
}

export { listProviders };
