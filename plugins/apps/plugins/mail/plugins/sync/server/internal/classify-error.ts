import { GmailApiError } from "@plugins/apps/plugins/mail/plugins/gmail-api/core";
import { RetryDeadlineError } from "@plugins/packages/plugins/retry/core";
import {
  GmailTokenUnavailableError,
  type MailSyncErrorCode,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";

// Maps any thrown sync failure to a user-facing classification: the error code
// that drives the remediation copy, a short readable message, and whether it is
// terminal (no retry can fix it → dead-letter + `status: "error"`) or transient
// (graphile keeps retrying → recorded as a non-terminal warning). Pure: no DB,
// no IO — so it can be unit-tested in isolation.

export interface MailSyncErrorClassification {
  code: MailSyncErrorCode;
  message: string;
  terminal: boolean;
}

const MAX_MESSAGE_LEN = 200;

/** Trim an arbitrary error message to a short, user-readable single value. */
function shortMessage(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > MAX_MESSAGE_LEN
    ? `${trimmed.slice(0, MAX_MESSAGE_LEN - 1)}…`
    : trimmed;
}

export function classifyMailSyncError(
  err: unknown,
): MailSyncErrorClassification {
  const message = shortMessage(
    err instanceof Error ? err.message : String(err),
  );

  // Token acquisition failure (`requireGmailToken`'s typed error) — the
  // account must be reconnected before any sync can resume.
  if (err instanceof GmailTokenUnavailableError) {
    return { code: "auth", message, terminal: true };
  }

  if (err instanceof GmailApiError) {
    if (err.status === 401) return { code: "auth", message, terminal: true };
    if (err.status === 403) {
      if (
        err.reason === "accessNotConfigured" ||
        /has not been used|is disabled|disabled/i.test(err.message)
      ) {
        return { code: "api_disabled", message, terminal: true };
      }
      if (
        err.reason === "insufficientPermissions" ||
        /insufficient authentication scopes/i.test(err.message)
      ) {
        return { code: "auth", message, terminal: true };
      }
      return { code: "unknown", message, terminal: true };
    }
    if (err.status === 429) return { code: "quota", message, terminal: false };
    if (err.status >= 500) return { code: "unknown", message, terminal: false };
    if (err.status === 400) return { code: "unknown", message, terminal: true };
    return { code: "unknown", message, terminal: true };
  }

  // Transient backoff exhausted (429/5xx retried past the deadline) — quota-like
  // and recoverable on the next tick.
  if (err instanceof RetryDeadlineError) {
    return { code: "quota", message, terminal: false };
  }

  return { code: "unknown", message, terminal: false };
}
