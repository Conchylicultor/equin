import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Under bun:test, `expect(p).rejects.<matcher>()` and `.resolves.<matcher>()`
 * are SYNCHRONOUS: the matcher drives the event loop until `p` settles (timers,
 * I/O, subprocesses included), asserts, and returns `undefined` — a mismatch
 * throws right there and fails the test. bun-types says so (`void`).
 *
 * So the one spelling is the bare statement. The `await` form is what a jest /
 * vitest habit writes, and `@typescript-eslint/await-thenable` then rejects it
 * with a message about thenables that reads like a bun typing bug — which sent
 * dozens of suites to hand-roll a `rejection(p)` try/catch helper. This rule
 * reports the same code first, with the real reason, and removes the `await`.
 *
 * One matcher does NOT honour the modifier: `toSatisfy` hands its predicate the
 * promise itself, not the value it settled with (bun 1.4.4; every other matcher
 * was probed) — so `.rejects.toSatisfy(e => …)` tests the wrong thing, and a
 * predicate true of any object passes vacuously. It is reported too.
 *
 * Scoped to files importing `bun:test`: under vitest (`web/__tests__/`) the
 * same chain IS a promise and must be awaited.
 */
export default createRule({
  name: "bun-sync-settle-matchers",
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "In a bun:test file, write `expect(p).rejects.toThrow(…)` / " +
        "`.resolves.…` without `await`: bun settles the promise synchronously " +
        "inside the matcher.",
    },
    schema: [],
    messages: {
      awaitedSettleMatcher:
        "bun:test settles `expect(p).{{which}}` synchronously — the matcher " +
        "runs the event loop until `p` settles, asserts, and returns " +
        "`undefined` (a mismatch throws here and fails the test). Drop the " +
        "`await`; never hand-roll a try/catch `rejection(p)` helper instead.",
      settledToSatisfy:
        "bun:test's `toSatisfy` ignores `.{{which}}`: its predicate receives " +
        "the promise itself, not the value it settled with, so this asserts " +
        "nothing about the outcome. Use `.{{which}}.toThrow(…)`, " +
        "`.toMatchObject(…)`, `.toBeInstanceOf(…)` or `.toHaveProperty(…)`.",
    },
  },
  defaultOptions: [],
  create(context) {
    let isBunTest = false;
    return {
      ImportDeclaration(node) {
        if (node.source.value === "bun:test") isBunTest = true;
      },
      "CallExpression:exit"(node: TSESTree.CallExpression) {
        if (!isBunTest) return;
        const { callee } = node;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "toSatisfy"
        ) {
          return;
        }
        const which = settleModifier(node);
        if (which === null) return;
        context.report({
          node,
          messageId: "settledToSatisfy",
          data: { which },
        });
      },
      "AwaitExpression:exit"(node: TSESTree.AwaitExpression) {
        if (!isBunTest) return;
        const which = settleModifier(node.argument);
        if (which === null) return;
        context.report({
          node,
          messageId: "awaitedSettleMatcher",
          data: { which },
          fix: (fixer) =>
            fixer.replaceText(node, context.sourceCode.getText(node.argument)),
        });
      },
    };
  },
});

/**
 * `"rejects"` / `"resolves"` when `node` is a matcher call on an `expect(…)`
 * chain that passes through that modifier, else null.
 */
function settleModifier(node: TSESTree.Node): "rejects" | "resolves" | null {
  if (node.type !== "CallExpression") return null;
  let which: "rejects" | "resolves" | null = null;
  let cur: TSESTree.Node = node.callee;
  while (cur.type === "MemberExpression") {
    if (
      !cur.computed &&
      cur.property.type === "Identifier" &&
      (cur.property.name === "rejects" || cur.property.name === "resolves")
    ) {
      which = cur.property.name;
    }
    cur = cur.object;
  }
  const isExpect =
    cur.type === "CallExpression" &&
    cur.callee.type === "Identifier" &&
    cur.callee.name === "expect";
  return isExpect ? which : null;
}
