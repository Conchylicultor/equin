import { z } from "zod";

/**
 * When an account's granted scopes shrank:
 * - `connect` — a (re)connect stored fewer scopes than the account held (the
 *   user unticked a permission on the provider's consent screen);
 * - `refresh` — a token refresh came back with fewer scopes than were stored
 *   (the provider narrowed the grant).
 */
export const ScopesLostDuringSchema = z.enum(["connect", "refresh"]);
export type ScopesLostDuring = z.infer<typeof ScopesLostDuringSchema>;

// The jsonb payload of an `auth-scopes-lost` report, filed by central through
// the report outbox. One row per (provider, account) — see the kind's fingerprint.
export const AuthScopesLostPayloadSchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  accountId: z.string(),
  during: ScopesLostDuringSchema,
  /** Scopes the account held before and no longer holds. */
  lost: z.array(z.string()),
  /** The scopes the account holds now. */
  granted: z.array(z.string()),
});
export type AuthScopesLostPayload = z.infer<typeof AuthScopesLostPayloadSchema>;

/** Scopes in `held` that are missing from `granted`, in `held`'s order. */
export function lostScopes(held: string[], granted: string[]): string[] {
  const have = new Set(granted);
  return [...new Set(held)].filter((s) => !have.has(s));
}

/**
 * A scope the way a person reads it: Google's URL scopes by their last
 * segment (`https://www.googleapis.com/auth/drive.file` → `drive.file`).
 */
export function scopeLabel(scope: string): string {
  const slash = scope.lastIndexOf("/");
  return slash === -1 ? scope : scope.slice(slash + 1);
}
