import { z } from "zod";

/**
 * How long a TRANSIENT refresh failure (Google unreachable, a 5xx, a timeout)
 * must last, in awake time, before it is reported. The access token is
 * refreshed from 5 min before it expires and retried every 60 s tick, so by
 * then the token has been expired for ~25 awake minutes and everything built
 * on it (Gmail, …) has stopped working. Central's log shows the blips this
 * must stay quiet for: DNS not back for a few minutes after each wake, in
 * runs of dark wakes that span an hour of wall clock but little awake time.
 */
export const TRANSIENT_REFRESH_REPORT_AFTER_MS = 30 * 60_000;

/**
 * - `permanent` — the provider refused the grant (a 400/401: `invalid_grant`,
 *   a revoked or deleted client). Only the user reconnecting fixes it, so it
 *   is reported at once.
 * - `transient` — anything else (network, 5xx, timeout): retried every tick,
 *   reported only once it has lasted {@link TRANSIENT_REFRESH_REPORT_AFTER_MS}.
 */
export const RefreshFailureKindSchema = z.enum(["permanent", "transient"]);
export type RefreshFailureKind = z.infer<typeof RefreshFailureKindSchema>;

// The jsonb payload of an `auth-refresh-failed` report, filed by central
// through the report outbox (central has no reports table; main drains it).
// One row per (provider, account, kind) — see the kind's fingerprint.
export const AuthRefreshFailedPayloadSchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  accountId: z.string(),
  kind: RefreshFailureKindSchema,
  /** The latest failure's error message. */
  error: z.string(),
  /** The provider's diagnosis of a refused grant, when it has one. */
  hint: z.string().optional(),
  /** Wall ms of the first failure of this run of failures. */
  sinceMs: z.number(),
  /** Awake time the refresh has been failing (machine sleep excluded where it can be measured). */
  failingMs: z.number(),
  /** Failed attempts in this run, the reported one included. */
  attempts: z.number(),
});
export type AuthRefreshFailedPayload = z.infer<
  typeof AuthRefreshFailedPayloadSchema
>;

/** A duration the way a report reads it: `45s`, `12m`, `5.5h`. */
export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
