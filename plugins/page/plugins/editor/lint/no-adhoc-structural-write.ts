import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * no-adhoc-structural-write
 *
 * A page's structural writes are ONE ORDERED STREAM. `optimistic-mutation`'s
 * model is `data = pendingOps.reduce(apply, serverTruth)` — an ordered fold — so
 * two causally dependent writes that leave as independent POSTs can land in
 * either order: the captured incident is a `split` reaching the server before
 * the `convertTo` it depended on, silently reverting the user's bullet one push
 * later.
 *
 * Order is therefore a property of the send lane the primitive keys by
 * `(resource, params)`, and the ONLY way onto that lane is the page's own
 * `useOptimisticResource` instance (`web/block-store.ts`) or the composite
 * router that fans writes out to it (`web/composite-block-store.tsx`, which also
 * owns the two lane-enqueued writes that carry no overlay). Every other caller
 * of the two structural endpoints would be a write outside the stream.
 *
 * So this rule flags `fetchEndpoint` / `useEndpointMutation` naming
 * `applyBlockOpEndpoint` or `patchBlocks` anywhere but those two files, which
 * the lint barrel exempts by PATH. It is the ORDER half of the guardrail; the
 * server-side ATOMICITY half is `no-adhoc-forest-write` plus the unforgeable
 * `PageForestTx` brand. Neither half is sufficient.
 *
 * `moveBlock` is deliberately NOT in the flagged set: it is a live endpoint for
 * two surfaces whose writes no page overlay can predict (the Pages sidebar's
 * `docRank` order, and the editor's cross-page drop). Both still enqueue onto a
 * lane where ordering matters.
 *
 * AST-only and self-contained: a contributed lint rule file is loaded by jiti,
 * which cannot resolve the `@plugins/*` tsconfig alias, so it may not import
 * across plugins.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** The two endpoints that write `page_blocks` structure. */
const STRUCTURAL_ENDPOINTS = new Set(["applyBlockOpEndpoint", "patchBlocks"]);

/** The two ways a client names an endpoint to call it. */
const ENDPOINT_CALLERS = new Set(["fetchEndpoint", "useEndpointMutation"]);

export default createRule({
  name: "no-adhoc-structural-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "no direct call to the page-structure endpoints outside the block store " +
        "(a write off the send lane is a write outside the page's ordered stream)",
    },
    schema: [],
    messages: {
      adhocWrite:
        "`{{caller}}({{endpoint}}, …)` writes a page's structure outside " +
        "`web/block-store.ts` / `web/composite-block-store.tsx`, the two modules " +
        "allowed to. A structural write must depart on the page's send lane, or a " +
        "causally dependent pair can reach the server in the wrong order and the " +
        "prediction diverges from server truth. Dispatch through the editor's " +
        "`BlockStore` (`dispatchOp` records the undo entry), or — for a write with " +
        "no mounted surface to predict it — `enqueueDetachedWrite(pageBlocks, " +
        "{ where: { pageId } }, …)` from `@plugins/primitives/plugins/optimistic-mutation/web`, " +
        "which also reports a rejection to the user. " +
        "See research/2026-08-01-page-structural-write-contract.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (callee.type !== "Identifier" || !ENDPOINT_CALLERS.has(callee.name))
          return;
        const arg = node.arguments[0];
        if (arg?.type !== "Identifier" || !STRUCTURAL_ENDPOINTS.has(arg.name))
          return;
        context.report({
          node,
          messageId: "adhocWrite",
          data: { caller: callee.name, endpoint: arg.name },
        });
      },
    };
  },
});
