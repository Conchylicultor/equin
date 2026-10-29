import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-adhoc-forest-write
 *
 * `page_blocks` is a forest with two non-deferrable partial unique indexes over
 * `(parent_id, rank)` and a denormalized `page_id` partition, and every
 * structural writer is a read-modify-write over the whole thing. Two concurrent
 * writers that each read the pre-state and write back a full row silently
 * reassert each other's columns — the captured incident is a `split` carrying
 * `parentId` from a pre-indent read, un-indenting a block with nothing to
 * observe it. So a forest write is only ever legal inside a transaction holding
 * that page's advisory lock.
 *
 * The TYPE closes the transitive half: every helper in
 * `server/internal/forest-writer.ts` requires a `PageForestTx`, which only
 * `withPageForest` can mint, so a handler that opens a bare `db.transaction`
 * fails to compile. This rule closes the DIRECT half: a future writer cannot
 * skip the helpers by importing `_blocks` and writing it by hand.
 *
 * It flags drizzle MUTATION calls naming the blocks table —
 * `.insert(_blocks)` / `.update(_blocks)` / `.delete(_blocks)` — anywhere but
 * `forest-writer.ts`, which is exempted by path in the lint barrel. Reads
 * (`.select().from(_blocks)`) are untouched: reading is what `ctx.forest()` is
 * for, and an unlocked read is not the hazard.
 *
 * AST-only and self-contained: a contributed lint rule file is loaded by jiti,
 * which cannot resolve the `@plugins/*` tsconfig alias, so it may not import
 * across plugins.
 */

const createRule = lintRuleCreator(import.meta.url);

/** The drizzle table binding the page editor writes its forest through. */
const BLOCKS_TABLE = "_blocks";

/** The three drizzle builder entry points that begin a write. */
const MUTATION_METHODS = new Set(["insert", "update", "delete"]);

export default createRule({
  name: "no-adhoc-forest-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "no direct page_blocks mutation outside the forest-writer chokepoint " +
        "(an unlocked forest write silently reasserts a concurrent writer's columns)",
    },
    schema: [],
    messages: {
      adhocWrite:
        "`.{{method}}({{table}})` writes the page forest outside " +
        "`server/internal/forest-writer.ts`, the one module allowed to. A forest write " +
        "must hold its page's advisory lock, or two concurrent structural writers " +
        "reassert each other's columns from stale snapshots. Open the write with " +
        "`withPageForest(pageScope, async (ctx) => …)` and call the forest-writer " +
        "helpers (`insertBlocks` / `updateBlockFields` / `deleteBlockRoots` / " +
        "`writeForestTarget` / `writeBlockPatch`), which require the `PageForestTx` " +
        "only `withPageForest` can mint. See " +
        "research/2026-08-01-page-structural-write-contract.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !MUTATION_METHODS.has(callee.property.name)
        ) {
          return;
        }
        // `.delete()` with no argument is the query-builder form drizzle does not
        // have; only a call naming the table is a forest write.
        const arg = node.arguments[0];
        if (arg?.type !== "Identifier" || arg.name !== BLOCKS_TABLE) return;
        context.report({
          node,
          messageId: "adhocWrite",
          data: { method: callee.property.name, table: BLOCKS_TABLE },
        });
      },
    };
  },
});
