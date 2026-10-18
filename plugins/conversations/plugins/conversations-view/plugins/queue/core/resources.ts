import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { RankSchema } from "@plugins/primitives/plugins/rank/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import {
  rankField,
  rankValueField,
} from "@plugins/fields/plugins/rank/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// One queue row: the conversation's position (`rank`) plus whether the user
// pinned it. The pin is a plain per-conversation flag living on the SAME row as
// the rank, so it needs no resource of its own — the ranks subscription the
// sidebar already holds carries it. `server/internal/tables.ts` builds the
// `conversations_ext_queue` table from this shape.
export const queueShape = defineExtensionShape({
  key: "conversationId",
  fields: { rank: rankField(), pinned: boolField() },
});
// The wire row is the shape's schema with `rank` decoded into a `Rank`. The
// `rank_text` column's field can only say `string`, so the decode is layered on
// here; an `.extend` replaces a key but can never drop one, so every column of
// the shape still reaches the wire.
export const QueueRankRowSchema = queueShape.schema.extend({
  rank: RankSchema,
});
export type QueueRankRow = z.infer<typeof QueueRankRowSchema>;

// The CLIENT-ASSEMBLED input type of `classifyQueue` — NO LONGER a wire shape.
// The queue was one push value; the sidebar now reads the ranks of the LIVE
// conversations as an id set of the `queueRanks` collection, and wraps them in
// this shape so `classifyQueue` stays a pure function of plain data.
export const QueueDataSchema = z.object({
  ranks: z.array(QueueRankRowSchema),
});
export type QueueData = z.infer<typeof QueueDataSchema>;

// The queue rows, one per conversation that has been ranked. The sidebar reads
// them as an explicit id set — the LIVE conversation ids it already tracks
// (`conversations-active`), `useOptimisticResource(queueRanks, { ids }, …)` —
// so ranks cost O(live), ~26 rows, not O(2726). Rows key on `conversationId`
// (the extension's key, whose column is the side-table's `parent_id` PK).
// The window (rank order) has no reader yet; it is bounded like any window.
// The `:rows` read is preloaded at boot, at the boot id set of
// `conversations-active` (the server half's `preloadRows`), so the queue's
// all-or-nothing gate settles on the first render.
export const queueRanks = liveCollection("queue-ranks", {
  // The shape's whole wire row, with `rank` decoded: the stored key's field
  // can only say `string`, so `carry.fields` reads it as the wire `Rank`
  // (`rankValueField`) — the same keys as the shape.
  from: queueShape,
  carry: { fields: { rank: rankValueField() } },
  id: "conversationId",
  sortable: ["rank"],
  default: { orderBy: [["rank", "asc"]], limit: 100 },
  maxLimit: 500,
});
