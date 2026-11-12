import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * `QueryCache.find(filters)` is a linear scan: `getAll().find(matchQuery)`, and
 * with `exact` (its default) `matchQuery` re-hashes the ASKED key once per
 * cached query (`@tanstack/query-core` `utils.ts`, `matchQuery`). So it is
 * O(cache) where the same lookup by hash is O(1) — and a loop over a tab's
 * live subs makes it O(subs × cache). The missed-update resync's
 * `up-to-date-batch` ran it per entry: 360–455 ms of main thread for 520 subs
 * (2026-11-12), almost all of it hashing.
 *
 * One tuple's query is `cachedQuery(queryClient, key, params)` (live-state
 * web) — `getQueryCache().get(defaultQueryOptions({ queryKey }).queryHash)`,
 * the lookup `getQueryState` / `getQueryData` make. A partial-key match is
 * `findAll` (a scan by nature, and named as one). Type-aware, so it matches the
 * cache by type, not by variable name.
 */
export default createRule({
  name: "no-linear-query-find",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow QueryCache.find(): a linear scan re-hashing the key per cached query. Look one tuple up by hash with cachedQuery(queryClient, key, params).",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      linearFind:
        "`QueryCache.find()` scans every cached query and re-hashes the key for each — O(cache) per call, O(subs × cache) in a loop. Use `cachedQuery(queryClient, key, params)` (network/live/live-state web): the O(1) lookup by hash `getQueryState` makes. A partial-key match is `findAll`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "find"
        )
          return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(callee.object);
        const type = checker.getNonNullableType(
          checker.getTypeAtLocation(tsNode),
        );
        const name = (type.getSymbol() ?? type.aliasSymbol)?.getName();
        if (name !== "QueryCache") return;
        context.report({ node, messageId: "linearFind" });
      },
    };
  },
});
