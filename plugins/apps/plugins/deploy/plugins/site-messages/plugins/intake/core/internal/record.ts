import { z } from "zod";

export const SITE_MESSAGE_VERDICTS = ["accepted", "spam"] as const;
export const SiteMessageVerdictSchema = z.enum(SITE_MESSAGE_VERDICTS);
export type SiteMessageVerdict = z.infer<typeof SiteMessageVerdictSchema>;

/** Why a message was filed as spam. */
export const SPAM_REASONS = ["honeypot", "too-fast", "bot-user-agent"] as const;
export const SpamReasonSchema = z.enum(SPAM_REASONS);
export type SpamReason = z.infer<typeof SpamReasonSchema>;

/**
 * Where a message's notification email stands.
 *
 * - `pending` — accepted, the notify job has not sent it yet (or is retrying;
 *   `notifyError` then holds the last attempt's error).
 * - `sent` — Resend accepted the email.
 * - `failed` — every attempt failed; `notifyError` says why.
 * - `not-configured` — the box has no approved Resend key.
 * - `throttled` — past the daily email cap: stored, not emailed; the next
 *   email that goes out counts it.
 * - `skipped` — spam is never emailed.
 */
export const NOTIFY_STATES = [
  "pending",
  "sent",
  "failed",
  "not-configured",
  "throttled",
  "skipped",
] as const;
export const NotifyStateSchema = z.enum(NOTIFY_STATES);
export type NotifyState = z.infer<typeof NotifyStateSchema>;

/** Spam rows are deleted this many days after they arrive; accepted ones are kept. */
export const SPAM_RETENTION_DAYS = 30;
