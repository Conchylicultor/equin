import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

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

/** One stored message, as the host-only list answers it. */
export const SiteMessageRecordSchema = z
  .object({
    id: z.string(),
    /** ISO instant. */
    createdAt: z.string().datetime(),
    message: z.string(),
    replyTo: z.string(),
    host: z.string(),
    page: z.string(),
    verdict: SiteMessageVerdictSchema,
    spamReason: SpamReasonSchema.nullable(),
    notifyState: NotifyStateSchema,
    notifyError: z.string().nullable(),
    notifiedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SiteMessageRecord = z.infer<typeof SiteMessageRecordSchema>;

/** The host-only list's page size: default, and the most one ask may take. */
export const SITE_MESSAGES_PAGE_DEFAULT = 100;
export const SITE_MESSAGES_PAGE_MAX = 200;

/** `GET /api/host-only/site-messages` — newest first, optionally one verdict. */
export const SiteMessagesListQuerySchema = z
  .object({
    verdict: SiteMessageVerdictSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SITE_MESSAGES_PAGE_MAX)
      .default(SITE_MESSAGES_PAGE_DEFAULT),
  })
  .strict();
export type SiteMessagesListQuery = z.input<typeof SiteMessagesListQuerySchema>;

/**
 * One bounded page, newest first. `hasMore` says the page was cut at its
 * limit — never that the box holds nothing more when it is false and the
 * page is empty.
 */
export const SiteMessagesPageSchema = z
  .object({
    kind: z.literal("messages"),
    messages: cappedList(SiteMessageRecordSchema, {
      max: SITE_MESSAGES_PAGE_MAX,
    }),
    hasMore: z.boolean(),
  })
  .strict();
export type SiteMessagesPage = z.infer<typeof SiteMessagesPageSchema>;
