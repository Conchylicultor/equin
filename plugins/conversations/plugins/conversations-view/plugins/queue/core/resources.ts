import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { RankSchema } from "@plugins/primitives/plugins/rank/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { nullable } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  rankField,
  rankValueField,
} from "@plugins/fields/plugins/rank/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { conversationSectionIdKind } from "./id-kinds";

/**
 * The reserved `section` value of the built-in Pinned section. Every other
 * non-null `section` is a user section's id (`csec-…`); `null` is the Queue.
 */
export const PINNED_SECTION = "pinned";

// One queue row: the conversation's position (`rank`) plus the section the
// user filed it into — `PINNED_SECTION`, a user section's id (`csec-…`), or
// `null` (the Queue). One spelling for membership: Pinned is just the reserved
// section key. The section is plain per-conversation user state living on the
// SAME row as the rank, so it needs no resource of its own — the ranks
// subscription the sidebar already holds carries it. Ranks stay ONE global
// rank space; a section's order is that space filtered.
// `server/internal/tables.ts` builds the `conversations_ext_queue` table from
// this shape.
export const queueShape = defineExtensionShape({
  key: "conversationId",
  fields: { rank: rankField(), section: nullable(textField()) },
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
// (`conversations-active`), `useLive(queueRanks, { ids })` —
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
  // The sidebar's id set is every LIVE conversation (`conversations-active`,
  // a whole set): ~30 today, so the window's 500 would do — but past it the
  // queue would stop reading. 2000 is far over any live set, still bounded.
  maxIds: 2000,
});

/** A user-made sidebar section: its name and its place among the sections. */
export const queueSectionFields = {
  id: idKindField(conversationSectionIdKind),
  name: textField({ label: "Name" }),
  rank: rankField(),
  createdAt: dateField(),
} satisfies FieldsRecord;

/** The `conversation_sections` entity — the user's own sidebar sections. */
export const queueSectionsEntityRef = entityRef(
  "conversation_sections",
  queueSectionFields,
);

// Every user-made section, in rank order: the sidebar draws them (empty ones
// included) between Pinned and Queue, so it needs the whole set. A user's own
// sections are a handful; 200 is far over any real set, still bounded (a load
// past it is a loud loader error, never a silent truncation). Preloaded at boot
// like the queue's ranks, so the sidebar never paints without its sections.
export const queueSections = liveCollection("queue-sections", {
  from: queueSectionsEntityRef,
  carry: {
    pick: ["id", "name", "createdAt"],
    fields: { rank: rankValueField() },
  },
  id: "id",
  all: { orderBy: [["rank", "asc"]], max: 200 },
  preload: "boot",
});
