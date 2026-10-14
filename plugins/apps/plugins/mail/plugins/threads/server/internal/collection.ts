import { serveCollection } from "@plugins/network/plugins/live/server";
import { _mailThreads } from "@plugins/apps/plugins/mail/plugins/mail-core/server";
import { mailThreads } from "../../core";

// The threads list, served straight off `mail_threads`: one table, identity
// routes only. The account is the tuple's own `accountId` filter (the pane
// scopes its source by the `mailAccount` value) — not a server-side subquery,
// which would read a second table the routes cannot see. The `labels` field
// is the `label_ids` jsonb array (its GIN index serves the mailbox tabs'
// containment ops).
export const mailThreadsServed = serveCollection(mailThreads, {
  from: _mailThreads,
  columns: { labels: (j) => j.base.labelIds },
});
