import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// The `conversations_ext_turn_summary` row, declared once:
// `server/internal/tables.ts` builds the side-table from this shape (and gives
// `caveats` / `actions` / `generatedAt` their DB defaults), and the wire row is
// its `schema`. Neither timestamp is on the wire — `generatedAt` is the one the
// card shows.
export const turnSummaryShape = defineExtensionShape({
  key: "conversationId",
  fields: {
    messageId: textField(),
    summary: textField(),
    caveats: textField(),
    actions: textField(),
    generatedAt: dateField(),
  },
});
export const TurnSummarySchema = turnSummaryShape.schema;
export type TurnSummary = z.infer<typeof TurnSummarySchema>;

// ONE conversation's latest turn summary, read by the conversation's id. The
// side-table is upserted per conversation — ONE row per conversation (its
// latest turn's summary), not one per turn — so it is a lookup-only
// collection: no default window (nothing lists every conversation's summary),
// minting `turn-summaries:rows` alone. The card reads its row with
// `useLiveRow(turnSummaryRows, conversationId)`, and `found: false` is "no
// summary yet". (`turnSummaries` is the server's extension handle, hence
// `…Rows`.)
//
// Bounded by construction: only the open conversation's card subscribes, a
// load is one primary-key seek, and the `:rows` point routing schedules a write
// for the one conversation whose row it named — a turn completing in one
// conversation never re-ships every conversation's summary to every tab.
//
// **The row id is `conversationId`, the table's primary key** (stored as
// `parent_id`): the point membership intersects the ids a write touched — PK
// values — with each card's id set.
//
// NOT preloaded (a lookup-only collection cannot be): the card hydrates
// post-mount via its sub-ack and renders nothing while pending.
//
// Served from the extension handle in `server/internal/resource.ts`.
export const turnSummaryRows = liveCollection("turn-summaries", {
  from: turnSummaryShape,
  id: "conversationId",
});
