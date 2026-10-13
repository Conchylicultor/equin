import { MailThreadSchema } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  liveBoolean,
  liveInstant,
  liveNumber,
  liveStringArray,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";

/**
 * The threads list's live collection: `mail_threads`, read by the DataView as
 * live key-range pages and kept fresh by the routed change
 * feed — a thread write refills exactly that thread in the live pages that hold (or
 * now admit) it, with no revision tick and no refetch of the loaded pages.
 *
 * `filterable` is the ONE declaration of what the list can filter on: the
 * DataView's Filter control offers exactly the fields whose column is here,
 * and the server strict-decodes against it. `labelIds` is the jsonb array every
 * mailbox tab's authored scope is a containment op over (the `labels` field
 * binds it through `MailThreadFieldSpec.column`). `snippet` has no field: it is
 * searched only. `accountId` has no field either: it is the SCOPE the pane
 * states as data (`mailThreadsSource.scoped({ where: { accountId } })`) — a
 * field cannot bind it (`MailThreadColumn` excludes it), and the DataView never
 * offers a scope column to the Filter control, so the user can neither name
 * nor widen it.
 *
 * `labelIds` is not sortable: a jsonb array has no order.
 *
 * `columnScope` is the threads DataView's id (`defineDataView("mail-threads")`,
 * asserted equal at mount): the user's custom columns on that surface sort and
 * filter the window server-side (`custom.<column id>`).
 */
export const mailThreads = liveCollection("mail.threads", {
  row: MailThreadSchema,
  id: "id",
  filterable: {
    accountId: liveText(),
    subject: liveText(),
    snippet: liveText(),
    lastMessageAt: liveInstant(),
    labelIds: liveStringArray(),
    unread: liveBoolean(),
    starred: liveBoolean(),
    important: liveBoolean(),
    hasAttachments: liveBoolean(),
    messageCount: liveNumber(),
  },
  sortable: ["subject", "lastMessageAt", "messageCount"],
  default: { orderBy: [["lastMessageAt", "desc"]], limit: 100 },
  maxLimit: 500,
  columnScope: "mail-threads",
});

/**
 * A column of the threads collection a field may bind to — never `accountId`,
 * the pane's scope (the DataView would not offer it to Filter anyway: a field
 * over a scope column only sorts).
 */
export type MailThreadColumn = Exclude<
  keyof typeof mailThreads.filterable | (typeof mailThreads.sortable)[number],
  "accountId"
>;
