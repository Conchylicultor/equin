import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { mailMessageFields } from "@plugins/apps/plugins/mail/plugins/mail-core/core";

// The message row, split into the one field the pane filters by (listed, so
// `where: { threadId }` type-checks) and the rest, carried.
const { threadId: _threadId, ...MESSAGE_CARRIED } = mailMessageFields;

// The messages of the mailbox, as a live collection — the reading pane reads
// one thread's window of it (`useLive(threadMessages, { where: { threadId } })`).
// The default window is the NEWEST 100 (`internalDate desc`, max 500): a
// reading pane most needs a long thread's latest replies, so the pane reverses
// the window for display (oldest→newest) and `loadMore` splits off the next
// key-range page of OLDER messages (pages, never a reload of the ones shown).
// A documented bounded exception to DataView: the pane reads ONE thread, so the
// 500 cap stays (`loadMore` stops at it). A message with no internal date
// (rare) sorts last under `desc` — so in a thread longer than one page it shows
// only once paging has reached it.
//
// The `threadId` filter is immutable (a message never changes threads) and
// `internalDate` is insert-immutable, so an in-place update — a flag flip, a
// body hydration — keeps the window's order signature and ships as one row.
// Bodies are null on the envelope stubs; the pane hydrates each message on
// first expand via the sync plugin's `mailHydrateMessageEndpoint` (cached
// thereafter).
export const threadMessages = liveCollection("mail-thread-messages", {
  fields: { threadId: textField({ label: "Thread" }) },
  carry: { fields: MESSAGE_CARRIED },
  id: "id",
  sortable: ["internalDate"],
  default: { orderBy: [["internalDate", "desc"]], limit: 100 },
  maxLimit: 500,
});
