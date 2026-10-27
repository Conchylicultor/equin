import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { sendEmail } from "@plugins/integrations/plugins/resend/server";
import { readDeploySecret } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";
import { CONTACT_EMAIL } from "@plugins/apps/plugins/website/plugins/shell/core";
import { RESEND_API_KEY, siteMessageIdKind } from "../../core";
import { confirmSiteMessage } from "./confirm";
import { notifySiteMessage } from "./notify";

/** Attempts before a send is recorded `failed` (graphile backs off between them). */
export const NOTIFY_MAX_ATTEMPTS = 5;
/** One Resend request's own deadline — what makes this a `seconds` job. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Emails one accepted message to the site's address, reply-to the visitor.
 * Keyed by message, so a re-enqueue collapses; serial, so the daily cap's count
 * is exact. Enqueued by the intake in the row's own transaction.
 */
export const siteMessagesNotifyJob = defineJob({
  name: "site-messages.notify",
  description:
    "Emails you each message a visitor sends through the site's contact form, so you can reply to them.",
  hold: "seconds",
  input: z.object({ messageId: siteMessageIdKind.schema }),
  event: z.never(),
  dedup: { key: (input) => input.messageId },
  serial: true,
  maxAttempts: NOTIFY_MAX_ATTEMPTS,
  async run({ input, ctx }) {
    await notifySiteMessage(db, input.messageId, {
      apiKey: readDeploySecret(RESEND_API_KEY),
      to: CONTACT_EMAIL,
      send: (apiKey, email) =>
        sendEmail(apiKey, email, {
          signal: AbortSignal.any([
            ctx.signal,
            AbortSignal.timeout(SEND_TIMEOUT_MS),
          ]),
        }),
      attempt: ctx.attempt,
      maxAttempts: NOTIFY_MAX_ATTEMPTS,
      now: new Date(),
    });
  },
});

/**
 * Emails the visitor a copy of one accepted message, so they know it arrived;
 * reply-to the site's address. Its own job (not a second send in the notify
 * one), so a retry of either email never resends the other. Keyed by message;
 * serial, so the caps' counts are exact. Enqueued with the notify job.
 */
export const siteMessagesConfirmJob = defineJob({
  name: "site-messages.confirm",
  description:
    "Emails each visitor a copy of the message they sent through the site's contact form, so they know it reached you.",
  hold: "seconds",
  input: z.object({ messageId: siteMessageIdKind.schema }),
  event: z.never(),
  dedup: { key: (input) => input.messageId },
  serial: true,
  maxAttempts: NOTIFY_MAX_ATTEMPTS,
  async run({ input, ctx }) {
    await confirmSiteMessage(db, input.messageId, {
      apiKey: readDeploySecret(RESEND_API_KEY),
      contact: CONTACT_EMAIL,
      send: (apiKey, email) =>
        sendEmail(apiKey, email, {
          signal: AbortSignal.any([
            ctx.signal,
            AbortSignal.timeout(SEND_TIMEOUT_MS),
          ]),
        }),
      attempt: ctx.attempt,
      maxAttempts: NOTIFY_MAX_ATTEMPTS,
      now: new Date(),
    });
  },
});
