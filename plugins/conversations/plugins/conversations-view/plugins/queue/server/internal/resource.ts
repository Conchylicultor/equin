import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationsActive } from "@plugins/tasks/plugins/tasks-core/core";
import { queueRanks, queueSections } from "../../core";
import { conversationsQueue, queueSectionsEntity } from "./tables";

// The queue rows, served from the queue extension's side-table. The extension
// handle is the source, so every row field binds to one of its wire columns
// and the id is its key `conversationId` (the `parent_id` PK). The sidebar's
// `{ ids }` read is the `:rows` point sibling: a rank insert/reseat reaches a
// tuple iff the changed conversation ids intersect its set, so `seedRankJob` on
// every `conversationCreated` ships a single-row delta to whatever tuple holds
// that id (none until the live set includes it), never a full re-select.
//
// There is deliberately NO dependency on the conversations resource: point
// routing gives that structurally — a status tick does not write a rank row.
// The `section` key rides the same row because it is user-set state, not
// something derived from conversation status; the sidebar section a filed row shows up
// in still follows status, but that is computed client-side from the
// conversations the sidebar already holds.
//
// Preloaded at the boot id set of `conversationsActive` (itself preloaded):
// the sidebar's tuple is exactly that set, so its ranks arrive in the boot
// snapshot with the conversations and the queue settles on its first render
// rather than one round trip after it.
export const queueRanksServed = serveCollection(queueRanks, {
  from: conversationsQueue,
  preloadRows: { idsOf: conversationsActive },
});

// The user's own sidebar sections, the whole (small, `max`-bounded) set in rank
// order, preloaded at boot so the sidebar never paints without them. The change
// feed carries every write; no notify.
export const queueSectionsServed = serveCollection(queueSections, {
  from: queueSectionsEntity,
});
