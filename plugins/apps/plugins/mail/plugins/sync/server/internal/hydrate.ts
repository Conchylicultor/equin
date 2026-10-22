import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getMessage } from "@plugins/apps/plugins/mail/plugins/gmail-api/server";
import { GmailApiError } from "@plugins/apps/plugins/mail/plugins/gmail-api/core";
import { MAIL_SYNC_REMEDIATION } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import {
  _mailMessages,
  requireGmailToken,
} from "@plugins/apps/plugins/mail/plugins/mail-core/server";
import { classifyMailSyncError } from "./classify-error";
import { isMessageHydrated, upsertMessageFull } from "./store";

// On-demand body hydration — the WRITE half of "fetch only when opened". The
// backfill mirrors only envelopes, so a message's body is null until this job
// fetches it (`format=full`) and caches it (`upsertMessageFull`: body,
// attachments, `bodyFetchedAt`). Readers never call it for an answer: they
// read the `mail.message-body` value (`body-value.ts`), whose subscription asks
// for a fetch (`requestHydration`) and whose answer follows this job's writes
// through the change feed — the body once it lands, or the failure recorded on
// the row (`bodyFetchError`) when it does not.

/** Why a body fetch failed, as the reader shows it. */
function failureText(err: unknown): string {
  if (err instanceof GmailApiError && err.status === 404) {
    return "Gmail no longer has this message.";
  }
  const { code, message } = classifyMailSyncError(err);
  if (code === "unknown") return message;
  const remediation = MAIL_SYNC_REMEDIATION[code];
  return `${remediation.title}. ${remediation.body}`;
}

/** Whether a failure is an expected state of the connection or the mailbox, not a bug. */
function isExpectedFailure(err: unknown): boolean {
  if (err instanceof GmailApiError && err.status === 404) return true;
  return classifyMailSyncError(err).code !== "unknown";
}

async function hydrateMessage(messageId: string): Promise<void> {
  const [row] = await db
    .select({
      accountId: _mailMessages.accountId,
      bodyFetchedAt: _mailMessages.bodyFetchedAt,
      bodyHtml: _mailMessages.bodyHtml,
      bodyText: _mailMessages.bodyText,
      bodyFetchError: _mailMessages.bodyFetchError,
    })
    .from(_mailMessages)
    .where(eq(_mailMessages.id, messageId))
    .limit(1);
  // Not in the mirror (the value refuses it `missing`), or cached already.
  if (!row || isMessageHydrated(row)) return;

  // A new attempt: the reader goes back to `fetching` while it runs.
  if (row.bodyFetchError !== null) {
    await db
      .update(_mailMessages)
      .set({ bodyFetchError: null })
      .where(eq(_mailMessages.id, messageId));
  }
  try {
    const { accessToken } = await requireGmailToken();
    const full = await getMessage(accessToken, messageId, "full");
    await upsertMessageFull(row.accountId, full);
  } catch (err) {
    // Recorded on the row so the reader shows it; a failure that is not an
    // expected state of the connection or mailbox is also a bug, so it still
    // fails the job loudly.
    await db
      .update(_mailMessages)
      .set({ bodyFetchError: failureText(err) })
      .where(eq(_mailMessages.id, messageId));
    if (!isExpectedFailure(err)) throw err;
  }
}

export const hydrateJob = defineJob({
  name: "mail.hydrate",
  description:
    "Fetches one opened message's full body and attachments from Gmail into the local mirror.",
  // seconds: one `messages.get?format=full` (under `gmailRequest`'s deadline)
  // plus the upsert.
  hold: "seconds",
  input: z.object({ messageId: z.string() }),
  event: z.never(),
  // Two tabs opening one message (or a Retry while a fetch runs) are one fetch.
  dedup: { key: ({ messageId }) => messageId },
  // The failure is recorded on the row; the reader's Retry asks again.
  maxAttempts: 1,
  run: async ({ input }) => {
    await hydrateMessage(input.messageId);
  },
});

/**
 * Ask for a message's body to be fetched, unless it is cached already or the
 * message is not in the mirror. Returns whether a fetch was queued.
 */
export async function requestHydration(messageId: string): Promise<boolean> {
  const [row] = await db
    .select({
      bodyFetchedAt: _mailMessages.bodyFetchedAt,
      bodyHtml: _mailMessages.bodyHtml,
      bodyText: _mailMessages.bodyText,
    })
    .from(_mailMessages)
    .where(eq(_mailMessages.id, messageId))
    .limit(1);
  if (!row || isMessageHydrated(row)) return false;
  await hydrateJob.enqueue({ messageId });
  return true;
}
