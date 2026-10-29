/**
 * Bans testing a resource result for "not ready" — the one-line way to fold
 * `loading` and `error` back into one state, which tsc cannot see.
 *
 * A result is `loading | error | ready`, and a failure must get its own answer:
 * a surface that asks "is it ready?" and treats every "no" alike spins forever
 * on a read that is never going to load (the build-history incident,
 * research/2026-09-27-global-live-resource-skew-and-error-state.md). So on a
 * resource-result binding (see `result-binding.ts`):
 *
 *   - `X.status !== "ready"` (or `!=`) is banned anywhere;
 *   - `X.status === "ready" ? a : b` is banned — its `b` branch is the lump;
 *   - comparing to `"loading"` or `"error"` is always fine, and so is an
 *     explicit `switch (X.status)` (a `case "loading": case "error":`
 *     fall-through names both states, so it is a decision, not an accident).
 *
 * Also caught through a destructured `const { status } = useLive(c)`.
 * Test code is exempt: an assertion's `if (r.status !== "ready") throw` lumps
 * nothing a user sees.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import {
  isDestructuredStatus,
  isResultBinding,
  isTestFile,
} from "./result-binding";

const createRule = lintRuleCreator(import.meta.url);

function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.type === AST_NODE_TYPES.TSAsExpression ||
    n.type === AST_NODE_TYPES.TSNonNullExpression
  ) {
    n = n.expression;
  }
  return n;
}

function isReadyLiteral(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  return n.type === AST_NODE_TYPES.Literal && n.value === "ready";
}

export default createRule({
  name: "no-ready-negation",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow `result.status !== "ready"` and `result.status === "ready" ? … : …` on resource results — both fold loading and error into one state.',
    },
    schema: [],
    messages: {
      readyNegation:
        '`{{name}} !== "ready"` folds `loading` and `error` into one state, so a failed read renders as if it were still loading (or as empty). ' +
        'Name the state you mean: `{{name}} === "loading"` / `=== "error"`, a `switch` over it, `matchResource` / `<ResourceView>`, or `foldResource` for a value. ' +
        "See plugins/primitives/plugins/live-state/CLAUDE.md.",
      readyTernary:
        '`{{name}} === "ready" ? … : …` sends `loading` and `error` down one branch, so a failed read renders as if it were still loading (or as empty). ' +
        "Use `matchResource` / `<ResourceView>` (JSX) or `foldResource` (a value) — each state gets its own answer. " +
        "See plugins/primitives/plugins/live-state/CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (isTestFile(context.filename)) return {};

    /** The `X.status` / destructured-`status` side of a comparison, as text for the message. */
    function statusSide(node: TSESTree.Node): string | null {
      const n = unwrap(node);
      if (
        n.type === AST_NODE_TYPES.MemberExpression &&
        !n.computed &&
        n.object.type === AST_NODE_TYPES.Identifier &&
        n.property.type === AST_NODE_TYPES.Identifier &&
        n.property.name === "status" &&
        isResultBinding(context, n.object)
      ) {
        return `${n.object.name}.status`;
      }
      if (
        n.type === AST_NODE_TYPES.Identifier &&
        n.name === "status" &&
        isDestructuredStatus(context, n)
      ) {
        return "status";
      }
      return null;
    }

    return {
      BinaryExpression(node) {
        const negated = node.operator === "!==" || node.operator === "!=";
        if (!negated && node.operator !== "===" && node.operator !== "==") {
          return;
        }
        const name = isReadyLiteral(node.right)
          ? statusSide(node.left)
          : isReadyLiteral(node.left)
            ? statusSide(node.right)
            : null;
        if (name === null) return;
        if (negated) {
          context.report({ node, messageId: "readyNegation", data: { name } });
          return;
        }
        const parent = node.parent;
        if (
          parent.type === AST_NODE_TYPES.ConditionalExpression &&
          parent.test === node
        ) {
          context.report({ node, messageId: "readyTernary", data: { name } });
        }
      },
    };
  },
});
