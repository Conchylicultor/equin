import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-unfiltered-blocks-read
 *
 * Every block delete is a TRASH: the `page_blocks` row stays, flagged
 * `deleted_at`, until purge (`server/internal/trash-blocks.ts`). So a plain
 * `.from(_blocks)` reads trashed rows alongside live ones, and a reader that
 * forgets the predicate resurrects deleted content — into a live resource, a
 * search index, a backlink panel, an agent's markdown read. The predicate is
 * easy to forget because nothing about the table's spelling asks for it.
 *
 * The fix is a relation on which the predicate is never written:
 * `liveBlocks` (`server/internal/live-blocks.ts`), a drizzle subquery over
 * `page_blocks WHERE deleted_at IS NULL`, exported from the editor's server
 * barrel beside `_blocks`. A reader `.from(liveBlocks)` cannot forget the
 * filter because it does not spell one. This rule closes the other route: it
 * flags every drizzle READ that names the raw table —
 * `.from(_blocks)` and `.<inner|left|right|full>Join(_blocks, …)` — anywhere
 * but the trash machinery, which is exempted by path in
 * its own `exempt/index.ts`: the modules that must see trashed rows to trash, restore, purge,
 * walk a cascade set, resolve a scope, or park a rank around them.
 *
 * Raw `sql\`… page_blocks …\`` reads are not seen by this rule (an AST rule
 * cannot read a template literal for SQL). They live under the same
 * allowlist convention — `collect-subtree.ts`, `page-doc-order.ts` and
 * `page-id.ts` are the three, each stating whether it filters and why — and a
 * new raw read belongs in an allowlisted module, never in a reader.
 *
 * Mutations (`.insert/.update/.delete(_blocks)`) are `no-adhoc-forest-write`'s.
 *
 * AST-only and self-contained: a contributed lint rule file is loaded by jiti,
 * which cannot resolve the `@plugins/*` tsconfig alias, so it may not import
 * across plugins.
 */

const createRule = lintRuleCreator(import.meta.url);

/** The drizzle table binding of `page_blocks`, trashed rows included. */
const BLOCKS_TABLE = "_blocks";

/** The drizzle builder entry points that bring a relation into a read. */
const READ_METHODS = new Set([
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
]);

export default createRule({
  name: "no-unfiltered-blocks-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "no drizzle read of the raw page_blocks table outside the trash machinery " +
        "(every delete is a trash, so an unfiltered read resurrects deleted rows)",
    },
    schema: [],
    messages: {
      unfilteredRead:
        "`.{{method}}({{table}})` reads the raw `page_blocks` table, trashed rows " +
        "included — every block delete is a trash (`deleted_at` set, row kept), so " +
        "this read resurrects deleted content. Read `liveBlocks` instead " +
        '(`import { liveBlocks } from "@plugins/page/plugins/editor/server"`; ' +
        "`.{{method}}(liveBlocks)` with `liveBlocks.<column>` in the predicate), " +
        "which is `page_blocks WHERE deleted_at IS NULL` with the predicate never " +
        "spelled by the reader. Only the trash machinery reads `{{table}}` — the " +
        "modules listed under this rule in `plugins/page/plugins/editor/lint/index.ts`.",
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
          !READ_METHODS.has(callee.property.name)
        ) {
          return;
        }
        // `Array.from(_blocks)` is the one `.from(...)` spelling that is not a
        // drizzle read: the receiver is the global, not a query builder.
        if (
          callee.object.type === "Identifier" &&
          callee.object.name === "Array"
        ) {
          return;
        }
        const arg = node.arguments[0];
        if (arg?.type !== "Identifier" || arg.name !== BLOCKS_TABLE) return;
        context.report({
          node,
          messageId: "unfilteredRead",
          data: { method: callee.property.name, table: BLOCKS_TABLE },
        });
      },
    };
  },
});
