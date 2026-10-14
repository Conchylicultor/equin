import { mailThreadsEntityRef } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { tagsField } from "@plugins/fields/plugins/tags/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";

/**
 * The threads list's live collection: `mail_threads`, read by the DataView as
 * live key-range pages and kept fresh by the routed change
 * feed — a thread write refills exactly that thread in the live pages that hold (or
 * now admit) it, with no revision tick and no refetch of the loaded pages.
 *
 * Declared by FIELDS: the thread entity's listed fields (their labels, types,
 * filter domains) are the list's — the DataView derives them, and the server
 * strict-decodes every filter against them. Their ids are the contract the
 * authored mailbox tabs (`config/apps/mail/threads/mail-threads.jsonc`) are
 * written against — rename one and its rules go with it.
 *
 * - `labels` is the axis every mailbox tab's scope is a containment op over —
 *   an own field the server binds to the `label_ids` jsonb array (the field
 *   id is the persisted vocabulary, the column's name is not). Not sortable: a
 *   jsonb array has no order.
 * - `snippet` is listed only to be searched (`mailThreadsSource`'s
 *   `searchable`), `accountId` only to be the SCOPE the pane states as data
 *   (`mailThreadsSource.scoped({ where: { accountId } })`) — the DataView
 *   never offers a scope column to the Filter control, so the user can
 *   neither name nor widen it. Both are off the list body
 *   (`web/internal/presentation.tsx`).
 *
 * `columnScope` is the threads DataView's id (`defineDataView("mail-threads")`,
 * asserted equal at mount): the user's custom columns on that surface sort and
 * filter the window server-side (`custom.<column id>`).
 */
export const mailThreads = liveCollection("mail.threads", {
  from: mailThreadsEntityRef,
  pick: [
    "subject",
    "lastMessageAt",
    "unread",
    "starred",
    "important",
    "hasAttachments",
    "messageCount",
    "snippet",
    "accountId",
  ],
  fields: { labels: tagsField({ label: "Labels" }) },
  carry: { pick: ["id", "participants", "createdAt"] },
  id: "id",
  sortable: ["subject", "lastMessageAt", "messageCount"],
  default: { orderBy: [["lastMessageAt", "desc"]], limit: 100 },
  maxLimit: 500,
  columnScope: "mail-threads",
});

/** One row of the threads list: the listed fields and what a row draws beside them. */
export type MailThreadRow =
  typeof mailThreads extends LiveRowsCollection<infer R> ? R : never;
