import { serveCollection } from "@plugins/network/plugins/live/server";
import { _mailMessages } from "@plugins/apps/plugins/mail/plugins/mail-core/server";
import { threadMessages } from "../../core";

// The thread-messages collection over `mail_messages`: its window (filtered on
// `threadId`, ordered by `internalDate`) and its `:rows` point sibling. The DB
// change-feed pushes any insert/update to a message in an open thread's window
// (a new reply, a flag change, a body hydration), so the pane stays live with no
// polling; `mail_messages_thread_id_idx` covers the filter.
//
// Envelope-only: the projection is the wire row schema, and bodies are null on
// the stub rows — the pane reads each expanded message's body through `sync`'s
// `mail.message-body` value.
export const threadMessagesServed = serveCollection(threadMessages, {
  from: _mailMessages,
});
