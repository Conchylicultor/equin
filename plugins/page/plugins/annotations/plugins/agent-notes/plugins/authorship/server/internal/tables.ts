import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { _blocks } from "@plugins/page/plugins/editor/server";

// One row per (agent-notes card, conversation that wrote into it). Presence of a
// row means "this conversation authored content in this card"; the whole set for
// a block is that card's provenance.
//
// ## A CHILD TABLE, not a 1:1 entity-extension holding an id array
//
// The relation is genuinely 1:N — a card accumulates authors as successive
// conversations append to it — and the two shapes are not equally honest about
// that:
//
//  - An array column (`defineExtension(_blocks, "agent_authors", {
//    conversationIds: text().array() })`) makes an append a READ-MODIFY-WRITE:
//    read the array, check membership, write it back. Two conversations writing
//    into the same card concurrently both read the pre-write array and the
//    second write silently drops the first's id. Serializing it would need an
//    explicit lock or an `array_append`-with-`NOT (… = ANY(…))` expression — a
//    hand-maintained uniqueness invariant.
//  - This table makes the same append `INSERT … ON CONFLICT DO NOTHING` against
//    the composite primary key, which is race-free BY CONSTRUCTION: dedupe is
//    the PK, not a check the writer must remember to perform. That is the
//    deciding argument — losing an author id is exactly the failure this record
//    exists to prevent.
//
// Using `defineExtension` here would also misuse the primitive: it documents
// itself as attaching typed 1:1 fields to a parent row, and its synthesized
// `parentId` PK is what makes it 1:1. A set is not a field.
//
// ## Growth bound
//
// The `block_id` FK CASCADE is the reclaim: rows die with the card. Asserted at
// boot by `markCascadeBounded` (see ../../machine/internal/growth-bound.ts) rather than
// trusted. Note `page_blocks` SOFT-deletes (trash), so the cascade fires at
// purge, not at the user's delete — the provenance survives a restore.
//
// ## Why `conversation_id` has NO foreign key
//
// Deliberate, and the same call `page/prompt/link` makes for its `blockId`: the
// record is a statement about the CARD ("an agent wrote this"), and that stays
// true after the conversation row is deleted. A CASCADE would erase the
// provenance and leave the card indistinguishable from human-written prose; a
// SET NULL would leave a row that says nothing. The cost is a possibly-dangling
// id, which the reader degrades on (an unresolvable conversation renders as its
// raw id).
//
// ## No secondary index
//
// The only read is `WHERE block_id = ?`, and the composite PK's implicit btree
// leads with `block_id` — so that seek, and the FK's own cascade-delete lookup,
// are both already covered. The `ORDER BY created_at` sorts a handful of rows
// (one card's authors); a second index would cost every write and buy nothing.
export const _pageBlocksAgentAuthors = pgTable(
  "page_blocks_agent_authors",
  {
    blockId: text("block_id")
      .notNull()
      .references(() => _blocks.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockId, t.conversationId] })],
);
