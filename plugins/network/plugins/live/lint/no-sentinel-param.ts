import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-sentinel-param
 *
 * A live read whose subject has not arrived yet (an id another read is still
 * loading) is spelled with `null`: `useLive(value, null)` / `useLiveRow(c,
 * null)` subscribes nothing and stays pending (a row read: not found). The old
 * workaround — a `""` stand-in, `{ id: x ?? "" }` — subscribes a real tuple the
 * server answers: a loader run (a query `WHERE id = ''`, a throw, a watcher
 * started for no conversation) on every mount, for a value nobody can use.
 *
 * Flags a `""` that can reach a `useLive` / `useLiveRow` /
 * `useOptimisticResource` params argument directly: the literal `""` as a param value (or as `useLiveRow`'s id), and
 * `x ?? ""`, `x || ""` or a conditional with a `""` branch in those places —
 * inside a conditional between two params objects too. A value computed
 * elsewhere is not traced — which is why a domain hook wrapping a read takes
 * its id as `string | null` (as `useLiveRow` does), never a `string` its
 * callers would have to fake.
 */

const READS = new Set(["useLive", "useLiveRow", "useOptimisticResource"]);

function isEmptyString(node: TSESTree.Node): boolean {
  return (
    (node.type === "Literal" && node.value === "") ||
    (node.type === "TemplateLiteral" &&
      node.expressions.length === 0 &&
      node.quasis.every((q) => q.value.cooked === ""))
  );
}

/** Whether evaluating `node` can yield a `""` written right there. */
function canYieldEmpty(node: TSESTree.Node): boolean {
  if (isEmptyString(node)) return true;
  if (
    node.type === "LogicalExpression" &&
    (node.operator === "??" || node.operator === "||")
  ) {
    return canYieldEmpty(node.right);
  }
  if (node.type === "ConditionalExpression") {
    return canYieldEmpty(node.consequent) || canYieldEmpty(node.alternate);
  }
  return false;
}

/** The `""`-yielding param values of a params argument (objects, possibly in a conditional). */
function sentinelValues(node: TSESTree.Node): TSESTree.Node[] {
  if (node.type === "ObjectExpression") {
    const out: TSESTree.Node[] = [];
    for (const p of node.properties) {
      if (p.type === "Property" && canYieldEmpty(p.value)) out.push(p.value);
    }
    return out;
  }
  if (node.type === "ConditionalExpression") {
    return [
      ...sentinelValues(node.consequent),
      ...sentinelValues(node.alternate),
    ];
  }
  if (node.type === "LogicalExpression") {
    return [...sentinelValues(node.left), ...sentinelValues(node.right)];
  }
  return [];
}

export default createRule({
  name: "no-sentinel-param",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow a `""` stand-in for a live read\'s param that has not arrived yet — pass `null` (useLive(value, null) / useLiveRow(c, null)).',
    },
    schema: [],
    messages: {
      sentinel:
        '`""` stands in for a param that has not arrived yet, and subscribes a ' +
        "real tuple the server loads for nothing. Pass `null` instead of the " +
        "params — `useLive(value, id === null ? null : { id })` / " +
        "`useLiveRow(c, id)` with a null id: nothing is subscribed, and the read " +
        "stays pending (a row read: not found). A subject that will NEVER arrive " +
        "is a settled answer the caller renders or throws on — see " +
        "plugins/network/plugins/live/CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier") return;
        if (!READS.has(node.callee.name)) return;
        const arg = node.arguments[1];
        if (arg === undefined || arg.type === "SpreadElement") return;
        const hits =
          node.callee.name === "useLiveRow"
            ? canYieldEmpty(arg)
              ? [arg]
              : []
            : sentinelValues(arg);
        for (const hit of hits)
          context.report({ node: hit, messageId: "sentinel" });
      },
    };
  },
});
