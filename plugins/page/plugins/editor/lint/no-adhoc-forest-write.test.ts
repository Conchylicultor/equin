/**
 * Tests for the `no-adhoc-forest-write` lint rule. Run with `bun test`.
 *
 * The valid/invalid lists are the real shapes from the page editor's server
 * tree: every read must pass, every mutation naming `_blocks` must fail (the one
 * sanctioned home, `forest-writer.ts`, is exempted by PATH in the lint barrel,
 * which this rule cannot and should not know about).
 */

import rule from "./no-adhoc-forest-write";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-forest-write", rule, {
  valid: [
    // Reads are the point of `ctx.forest()` / `loadPageBlocks`; an unlocked
    // READ is not the hazard this rule exists for.
    { code: `await tx.select().from(_blocks).where(eq(_blocks.id, id));` },
    {
      code: `await ctx.tx.selectDistinct({ pageId: _blocks.pageId }).from(_blocks);`,
    },
    // The sanctioned route: the forest-writer helpers, which require the brand.
    { code: `await updateBlockFields(ctx.tx, id, { rank });` },
    { code: `await deleteBlockRoots(ctx.tx, rootIds);` },
    { code: `await insertBlocks(ctx.tx, rows);` },
    // Another table's mutation is another plugin's business.
    { code: `await tx.insert(_trashEntries).values(entry);` },
    {
      code: `await tx.delete(_pageLinks).where(inArray(_pageLinks.sourcePageId, ids));`,
    },
    // A member named `update` that is not a drizzle mutation entry point.
    { code: `editor.update(_blocksRef);` },
  ],
  invalid: [
    {
      code: `await tx.insert(_blocks).values(rows);`,
      errors: [{ messageId: "adhocWrite" }],
    },
    {
      code: `await tx.update(_blocks).set({ rank }).where(eq(_blocks.id, id));`,
      errors: [{ messageId: "adhocWrite" }],
    },
    {
      code: `await tx.delete(_blocks).where(inArray(_blocks.id, rootIds));`,
      errors: [{ messageId: "adhocWrite" }],
    },
    // A pool write is no better than a transactional one — it holds no lock at all.
    {
      code: `await db.update(_blocks).set({ expanded: true }).where(eq(_blocks.id, id));`,
      errors: [{ messageId: "adhocWrite" }],
    },
    // The executor being a branded tx does not license bypassing the helpers:
    // the helpers are where the write shapes (field-scoped vs whole-row) live.
    {
      code: `await ctx.tx.update(_blocks).set(fullRow(b)).where(eq(_blocks.id, b.id));`,
      errors: [{ messageId: "adhocWrite" }],
    },
    // Every offender in a file is reported, and the read between them is not.
    {
      code:
        `await tx.insert(_blocks).values(rows);` +
        `await tx.select().from(_blocks);` +
        `await tx.delete(_blocks).where(w);`,
      errors: [{ messageId: "adhocWrite" }, { messageId: "adhocWrite" }],
    },
  ],
});
