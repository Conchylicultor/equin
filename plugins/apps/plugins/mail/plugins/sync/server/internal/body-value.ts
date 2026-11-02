import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import {
  _mailAttachments,
  _mailMessages,
} from "@plugins/apps/plugins/mail/plugins/mail-core/server";
import {
  mailMessageAttachments,
  mailMessageBodies,
  mailMessageBody,
  type MailMessageBody,
} from "../../core";
import { isMessageHydrated } from "./store";
import { requestHydration } from "./hydrate";

// The rows `mailMessageBody` follows: one message's body columns, and its
// attachment rows.
export const mailMessageBodiesServed = serveCollection(mailMessageBodies, {
  from: _mailMessages,
});
export const mailMessageAttachmentsServed = serveCollection(
  mailMessageAttachments,
  { from: _mailAttachments },
);

// One message's body, served from the mirror. The loader only READS: a cached
// body is `ready`, a recorded failure `failed`, anything else `fetching`. The
// fetch itself is the `mail.hydrate` job's write, asked for when a reader
// subscribes to a message whose body is not cached (`whileSubscribed`). It
// follows the message's body columns and its attachment rows, so the job's
// write recomputes that message's open body — and a sync writing other
// messages, or this one's labels and flags, recomputes none.
export const mailMessageBodyServed = serveValue(mailMessageBody, {
  source: "db",
  follows: (follow) => ({
    body: follow(mailMessageBodiesServed, ({ messageId }) => ({
      ids: [messageId],
    })),
    attachments: follow(mailMessageAttachmentsServed, ({ messageId }) => ({
      where: { messageId },
    })),
  }),
  // A delta sync writes many message rows at once; each open body re-reads at
  // most once per window.
  throttleMs: 500,
  loader: ({ messageId }, { followed }): MailMessageBody => {
    const row = followed.body[0];
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
    return {
      state: "ready",
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      attachments: [...followed.attachments],
    };
  },
  whileSubscribed: async ({ messageId }) => {
    await requestHydration(messageId);
    return () => {};
  },
});
