/**
 * Tests for the `no-unfiltered-blocks-read` lint rule. Run with `bun test`.
 *
 * The valid/invalid lists are the real shapes from the readers of the page
 * forest: every read through `liveBlocks` must pass, every drizzle read naming
 * the raw `_blocks` table must fail (the trash machinery's own reads are
 * exempted by PATH in the lint barrel, which this rule cannot and should not
 * know about). Mutations naming `_blocks` are `no-adhoc-forest-write`'s and
 * must pass here.
 */

import rule from "./no-unfiltered-blocks-read";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-unfiltered-blocks-read", rule, {
  valid: [
    // The sanctioned relation: the predicate is never spelled by the reader.
    {
      code: `await db.select().from(liveBlocks).where(eq(liveBlocks.id, id));`,
    },
    {
      code: `await db.select(BLOCK_WIRE_COLUMNS).from(liveBlocks).orderBy(asc(liveBlocks.rank));`,
    },
    {
      code: `await tx.selectDistinct({ pageId: liveBlocks.pageId }).from(liveBlocks);`,
    },
    {
      code: `await db.select({ id: liveBlocks.id }).from(_pageLinks).innerJoin(liveBlocks, eq(_pageLinks.sourcePageId, liveBlocks.id));`,
    },
    // Mutations are the other rule's; a write is not an unfiltered read.
    { code: `await tx.insert(_blocks).values(rows);` },
    {
      code: `await tx.update(_blocks).set({ rank }).where(eq(_blocks.id, id));`,
    },
    { code: `await tx.delete(_blocks).where(inArray(_blocks.id, ids));` },
    // Another table's read is another plugin's business.
    {
      code: `await db.select().from(_trashEntries).where(eq(_trashEntries.id, id));`,
    },
    {
      code: `await db.select().from(_pageLinks).innerJoin(_pageBlockDocs, on);`,
    },
    // A column reference alone is not a read of the table: predicates and
    // projections over `_blocks.<col>` are legal wherever the relation read is.
    {
      code: `const rank = _blocks.rank; const w = and(eq(_blocks.id, id), isNull(_blocks.deletedAt));`,
    },
    // The one `.from(...)` receiver that is not a query builder.
    { code: `Array.from(_blocks);` },
    { code: `emitter.from(_blocksRef);` },
  ],
  invalid: [
    {
      code: `await db.select().from(_blocks).where(eq(_blocks.id, id));`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    // The predicate being spelled by hand is exactly what the rule retires:
    // a filtered read of the raw table is still a read of the raw table.
    {
      code: `await db.select().from(_blocks).where(and(eq(_blocks.id, id), isNull(_blocks.deletedAt)));`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    {
      code: `await tx.selectDistinct({ pageId: _blocks.pageId }).from(_blocks);`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    {
      code: `await db.select(BLOCK_WIRE_COLUMNS).from(_blocks).orderBy(asc(_blocks.rank));`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    // Every join flavour brings the raw table into the read.
    {
      code: `await db.select().from(_pageLinks).innerJoin(_blocks, eq(_pageLinks.sourcePageId, _blocks.id));`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    {
      code: `await db.select().from(_pageLinks).leftJoin(_blocks, on);`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    {
      code: `await db.select().from(_pageLinks).rightJoin(_blocks, on);`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    {
      code: `await db.select().from(_pageLinks).fullJoin(_blocks, on);`,
      errors: [{ messageId: "unfilteredRead" }],
    },
    // Every offender in a file is reported, and the live read between them is not.
    {
      code:
        `await db.select().from(_blocks);` +
        `await db.select().from(liveBlocks);` +
        `await db.select().from(_pageLinks).innerJoin(_blocks, on);`,
      errors: [
        { messageId: "unfilteredRead" },
        { messageId: "unfilteredRead" },
      ],
    },
  ],
});
