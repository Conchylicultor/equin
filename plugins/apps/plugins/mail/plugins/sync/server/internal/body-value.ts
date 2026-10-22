import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  _mailAttachments,
  _mailMessages,
} from "@plugins/apps/plugins/mail/plugins/mail-core/server";
import { mailMessageBody, type MailMessageBody } from "../../core";
import { isMessageHydrated } from "./store";
import { requestHydration } from "./hydrate";

// One message's body, served from the mirror. The loader only READS: a cached
// body is `ready`, a recorded failure `failed`, anything else `fetching`. The
// fetch itself is the `mail.hydrate` job's write, asked for when a reader
// subscribes to a message whose body is not cached (`whileSubscribed`); the
// job's writes to `mail_messages` / `mail_attachments` recompute every
// subscribed tuple through the change feed.
export const mailMessageBodyServed = serveValue(mailMessageBody, {
  source: "db",
  reads: {
    tables: [_mailMessages, _mailAttachments],
    reason:
      "one message's body columns and attachment rows, read by id — whole-table until it reads through a collection; a tuple is one pk lookup, and the open bodies are the few cards a reader has expanded",
  },
  // A delta sync writes many message rows at once; each open body re-reads at
  // most once per window.
  throttleMs: 500,
  loader: async ({ messageId }): Promise<MailMessageBody> => {
    const [row] = await db
      .select({
        bodyText: _mailMessages.bodyText,
        bodyHtml: _mailMessages.bodyHtml,
        bodyFetchedAt: _mailMessages.bodyFetchedAt,
        bodyFetchError: _mailMessages.bodyFetchError,
      })
      .from(_mailMessages)
      .where(eq(_mailMessages.id, messageId))
      .limit(1);
    if (!row) {
      throw mailMessageBody.refuse(
        "missing",
        `Message ${messageId} is not in the local mailbox`,
      );
    }
    if (!isMessageHydrated(row)) {
      return row.bodyFetchError === null
        ? { state: "fetching" }
        : { state: "failed", error: row.bodyFetchError };
    }
    const attachments = await db
      .select()
      .from(_mailAttachments)
      .where(eq(_mailAttachments.messageId, messageId));
    return {
      state: "ready",
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      attachments,
    };
  },
  whileSubscribed: async ({ messageId }) => {
    await requestHydration(messageId);
    return () => {};
  },
});
