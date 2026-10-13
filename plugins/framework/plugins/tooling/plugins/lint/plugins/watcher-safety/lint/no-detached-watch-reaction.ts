import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type * as ts from "typescript";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** The reaction types a watch coalesces (`infra/file-watcher`'s engine). */
const REACTION_ALIASES = new Set(["WatchReaction", "WatchReconcile"]);

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

function enclosingFunction(node: TSESTree.Node): FunctionNode | null {
  // Truthy, not `!== undefined`: the Program's parent is `null` at runtime.
  for (let n = node.parent; n; n = n.parent) {
    if (
      n.type === "ArrowFunctionExpression" ||
      n.type === "FunctionExpression" ||
      n.type === "FunctionDeclaration"
    ) {
      return n;
    }
  }
  return null;
}

function isReactionType(t: ts.Type): boolean {
  if (t.aliasSymbol !== undefined && REACTION_ALIASES.has(t.aliasSymbol.name))
    return true;
  return t.isUnion() && t.types.some(isReactionType);
}

/**
 * A watch callback must RETURN its async work, never detach it with `void`.
 *
 * The watch layer (`defineFileWatcher`, `acquireDirWatch`,
 * `acquireCheckoutWatch`, `watchForCommand`) runs one reaction at a time per
 * subscriber and folds the batches landing meanwhile into one trailing call —
 * but only for work it can see. `onChange: () => { void recompute(); }` starts
 * one recompute per batch, unbounded: a fast-changing folder against slow work
 * queued 3,291 edited-files recomputes behind a 2-slot gate and blanked main
 * (2026-10-12).
 *
 * Scoped by TYPE, not by name: a `void <thenable>` whose nearest enclosing
 * function is contextually typed as a `WatchReaction` / `WatchReconcile`.
 */
export default createRule({
  name: "no-detached-watch-reaction",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow detaching async work (`void promise`) in a file-watch callback: return it, so the watch coalesces it to one running plus one pending run.",
    },
    schema: [],
    messages: {
      detached:
        "Detached async work in a watch callback runs once per change batch, unbounded. Return (or await) the promise instead — the watch runs one reaction at a time per subscriber and folds the batches landing meanwhile into one trailing call. For work keyed inside one batch (one run per room), trigger a `createKeyedCoalescer` from `@plugins/packages/plugins/coalesce/core`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const nodeMap = services.esTreeNodeToTSNodeMap;

    const isThenable = (node: TSESTree.Node): boolean => {
      const t = checker.getTypeAtLocation(nodeMap.get(node));
      const parts = t.isUnion() ? t.types : [t];
      return parts.some(
        (p) => checker.getApparentType(p).getProperty("then") !== undefined,
      );
    };

    return {
      'UnaryExpression[operator="void"]'(node: TSESTree.UnaryExpression) {
        const fn = enclosingFunction(node);
        if (fn === null || fn.type === "FunctionDeclaration") return;
        const contextual = checker.getContextualType(
          nodeMap.get(fn) as ts.Expression,
        );
        if (contextual === undefined || !isReactionType(contextual)) return;
        if (!isThenable(node.argument)) return;
        context.report({ node, messageId: "detached" });
      },
    };
  },
});
