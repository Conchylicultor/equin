import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { getMessage } from "@plugins/apps/plugins/mail/plugins/gmail-api/server";
import {
  _mailAttachments,
  _mailMessages,
  requireGmailToken,
} from "@plugins/apps/plugins/mail/plugins/mail-core/server";
import type {
  MailAttachment,
  MailMessage,
} from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { isMessageHydrated, upsertMessageFull } from "./store";

// On-demand body hydration: fetch + cache one message's full MIME body the first
// time it is opened, then serve it from the local mirror forever after. This is
// the "fetch only when opened" half of the on-demand sync model — the backfill
// mirrors only envelopes, so a message's body is null until this runs.
//
// Cache-first: an already-hydrated message (or a full-backfilled row from before
// on-demand sync) is returned straight from Postgres with no Gmail round-trip.
// A cache miss fetches `format=full`, upserts the body + attachments (stamping
// `bodyFetchedAt`), then re-reads. The message must already exist as an
// envelope stub in the mirror — hydrating an unknown id is a 404
// (older-than-window mail arrives via on-demand search, a later phase).

export async function hydrateMessage(messageId: string): Promise<{
  message: MailMessage;
  attachments: MailAttachment[];
}> {
  const [row] = await db
    .select()
    .from(_mailMessages)
    .where(eq(_mailMessages.id, messageId))
    .limit(1);
  if (!row) {
    throw new HttpError(404, `Message ${messageId} is not in the local mailbox`);
  }

  if (!isMessageHydrated(row)) {
    // Cache miss — fetch the full body once and persist it. A Gmail failure
    // (token/permission/transient) propagates loudly to the caller.
    const { accessToken } = await requireGmailToken();
    const full = await getMessage(accessToken, messageId, "full");
    await upsertMessageFull(row.accountId, full);
  }

  return readHydrated(messageId);
}

/** Read the (now-cached) message + its attachments back out of the mirror. */
async function readHydrated(messageId: string): Promise<{
  message: MailMessage;
  attachments: MailAttachment[];
}> {
  const [message] = await db
    .select()
    .from(_mailMessages)
    .where(eq(_mailMessages.id, messageId))
    .limit(1);
  if (!message) {
    // Vanishingly rare — deleted between the fetch and this read.
    throw new HttpError(404, `Message ${messageId} is not in the local mailbox`);
  }
  const attachments = await db
    .select()
    .from(_mailAttachments)
    .where(eq(_mailAttachments.messageId, messageId));
  return { message, attachments };
}
