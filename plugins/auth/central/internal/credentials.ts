import type {
  AuthEnvAccessor,
  AuthProviderDescriptor,
  ResolvedCredentials,
} from "@plugins/auth/core";
import {
  readEnv,
  type EnvKey,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { AuthCredentialsMissingError, AuthError } from "@plugins/auth/core";

const envAccessor: AuthEnvAccessor = {
  // The env KEY (`AUTH_<PROVIDER>_CLIENT_ID`), read under every name of it.
  get(key: EnvKey): string | undefined {
    const v = readEnv(key);
    return v && v.length > 0 ? v : undefined;
  },
};

const credCache = new Map<string, Promise<ResolvedCredentials>>();

/**
 * Resolve a provider's OAuth client credentials.
 *
 * Each provider plugin's descriptor implements `resolveCredentials`. Typical
 * implementation: try env vars first (`EQUIN_AUTH_<PROVIDER>_CLIENT_ID`
 * / `..._CLIENT_SECRET`), then read user-pasted values from the secrets store
 * via `readSecretConfig` (auth runs on central — there is no per-worktree DB
 * to consult). If neither yields a clientId, throw AuthCredentialsMissingError
 * so the UI can render the "configure credentials" empty state.
 *
 * Cached per-provider so concurrent token requests share one resolution.
 */
export async function resolveCredentials(
  descriptor: AuthProviderDescriptor,
): Promise<ResolvedCredentials> {
  if (descriptor.kind !== "oauth2" || !descriptor.oauth) {
    throw new Error(
      `auth: resolveCredentials called for non-oauth2 provider "${descriptor.id}"`,
    );
  }
  const cached = credCache.get(descriptor.id);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const result = await descriptor.oauth!.resolveCredentials(envAccessor);
      if (!result.clientId) {
        throw new AuthCredentialsMissingError(descriptor.id);
      }
      return result;
    } catch (err) {
      // Drop from cache so a fresh attempt re-runs after the user fills in keys.
      credCache.delete(descriptor.id);
      throw err;
    }
  })();
  credCache.set(descriptor.id, promise);
  return promise;
}

export function invalidateCredentialsCache(providerId?: string): void {
  if (providerId) credCache.delete(providerId);
  else credCache.clear();
}

export async function tryResolveCredentials(
  descriptor: AuthProviderDescriptor,
): Promise<ResolvedCredentials | null> {
  try {
    return await resolveCredentials(descriptor);
  } catch (err) {
    if (err instanceof AuthError) return null;
    throw err;
  }
}
