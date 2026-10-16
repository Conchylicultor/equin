import { asc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { agentNotesAuthors } from "../../shared/schemas";
import { _pageBlocksAgentAuthors as t } from "./tables";

// Server half of the per-card authorship read: a db-arm value declaring this table
// as its reads, so a stamp recomputes every subscribed card's tuple — a FULL recompute, with no scope
// policy to route on. That is correct, and the right trade: the table's key is
// the composite `(block_id, conversation_id)`, and a surrogate id column would
// buy per-row routing at the price of a meaningless key and a separate unique
// index to make `ON CONFLICT` work, while the recompute it avoids is one indexed
// single-block query over a handful of rows, on a table written once per agent
// note. Push drops the tuples whose result did not change.
//
// The order is TOTAL (`conversation_id` breaks a `created_at` tie): a value is
// delivered in the loader's order, its first record IS the creator
// (`useAgentNotesCreator`), and push compares bytes — so two recomputes over
// the same rows must not come back in two orders.
export const agentNotesAuthorsServed = serveValue(agentNotesAuthors, {
  source: "db",
  reads: {
    tables: [t],
    reason:
      "one card's authors; the table has a composite key, so any stamp may change any subscribed card — whole-table until it reads through a collection",
  },
  unbounded: {
    reason: "one card's authors — the conversations that wrote into one block",
  },
  loader: ({ blockId }) =>
    db
      .select({
        blockId: t.blockId,
        conversationId: t.conversationId,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(eq(t.blockId, blockId))
      .orderBy(asc(t.createdAt), asc(t.conversationId)),
});
