import { ASTUtils, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * no-grow-in-effect
 *
 * A list read's `loadMore()` is a user's (or a viewport's) request for more
 * rows. Called from a `useEffect` / `useLayoutEffect` it becomes the AUTO-GROW
 * loop — "while the window is full, grow it" — which is a reader treating a
 * bounded window as the whole set: it reloads ever larger windows until the
 * cap, and past the cap still drops rows silently. A reader that needs every
 * row of a set reads a collection declared `all`; a surface that pages as the
 * user scrolls goes through data-view (or `useInfiniteScroll`), whose
 * `fetchNextPage` a visible sentinel drives.
 *
 * Flags, anywhere inside an effect's callback:
 * - a call of a `loadMore` member — `result.loadMore()`, `r?.loadMore()`;
 * - a call of a binding named `loadMore` (unless it is a function this file
 *   defines under that name — then it is not a read's handle), or one
 *   destructured from a `loadMore` property (`const { loadMore: grow } =
 *   result`);
 * - a call of a binding whose initializer reads a `loadMore` member without
 *   calling it (`const grow = ready ? result.loadMore : null; … grow?.()`);
 * - an effect whose callback IS one of those (`useEffect(result.loadMore)`).
 * A value passed through anything else (a prop, a hook's return) is not traced.
 *
 * Nested closures count, DELIBERATELY including handlers the effect registers
 * (an `IntersectionObserver` callback, a scroll listener): a hand-built pager
 * wired from an effect is the sentinel data-view and `useInfiniteScroll`
 * already own — measured against the real viewport, error-gated, never
 * re-armed by a render — so it is pointed there rather than allowed.
 */

const EFFECTS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

function isEffectCallee(callee: TSESTree.Node): boolean {
  if (callee.type === "Identifier") return EFFECTS.has(callee.name);
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    EFFECTS.has(callee.property.name)
  );
}

function isLoadMoreMember(node: TSESTree.Node): boolean {
  return (
    node.type === "MemberExpression" &&
    ((!node.computed &&
      node.property.type === "Identifier" &&
      node.property.name === "loadMore") ||
      (node.computed &&
        node.property.type === "Literal" &&
        node.property.value === "loadMore"))
  );
}

/** Whether `node` reads a `loadMore` member without calling it. */
function readsLoadMore(node: TSESTree.Node | null | undefined): boolean {
  if (node == null) return false;
  if (isLoadMoreMember(node)) {
    const parent = node.parent;
    return !(parent?.type === "CallExpression" && parent.callee === node);
  }
  if (node.type === "ConditionalExpression") {
    return readsLoadMore(node.consequent) || readsLoadMore(node.alternate);
  }
  if (node.type === "LogicalExpression") {
    return readsLoadMore(node.left) || readsLoadMore(node.right);
  }
  if (
    node.type === "ChainExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression"
  ) {
    return readsLoadMore(node.expression);
  }
  return false;
}

export default createRule({
  name: "no-grow-in-effect",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calling a live read's `loadMore()` from a useEffect / useLayoutEffect — the auto-grow loop that reads a window as the whole set.",
    },
    schema: [],
    messages: {
      growInEffect:
        "`loadMore()` called from an effect grows the window on its own until " +
        "it is full — reading a bounded window as the whole set, which still " +
        "drops rows past its cap. A reader that needs every row reads a " +
        "collection declared `all` (`liveCollection(key, { all: { orderBy, " +
        "unbounded: { reason } } })`, read with `useLive(c)`); a list that " +
        "pages as the user scrolls goes through data-view or " +
        "`useInfiniteScroll`. See plugins/network/plugins/live/CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    /** Whether the identifier `id` is bound to a `loadMore` handle. */
    function isGrowBinding(id: TSESTree.Identifier): boolean {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(id),
        id,
      );
      const defs = variable?.defs ?? [];
      if (id.name === "loadMore") {
        // A function of this file's own that happens to be called `loadMore`
        // is no read's handle; any other `loadMore` (destructured, a
        // parameter, a global) is taken for one.
        return !defs.some(
          (def) =>
            def.type === "FunctionName" ||
            (def.node.type === "VariableDeclarator" &&
              def.node.id === def.name &&
              (def.node.init?.type === "ArrowFunctionExpression" ||
                def.node.init?.type === "FunctionExpression")),
        );
      }
      for (const def of defs) {
        if (def.node.type !== "VariableDeclarator") continue;
        const parent = def.name.parent;
        // `const { loadMore: grow } = result` — the name's property key.
        if (
          parent?.type === "Property" &&
          parent.value === def.name &&
          !parent.computed &&
          parent.key.type === "Identifier" &&
          parent.key.name === "loadMore"
        ) {
          return true;
        }
        if (def.node.id === def.name && readsLoadMore(def.node.init)) {
          return true;
        }
      }
      return false;
    }

    /** Whether calling (or running) `node` grows a read. */
    function isGrow(node: TSESTree.Node): boolean {
      if (node.type === "ChainExpression") return isGrow(node.expression);
      if (isLoadMoreMember(node)) return true;
      return node.type === "Identifier" && isGrowBinding(node);
    }

    /** Whether `node` sits inside the callback of an effect. */
    function insideEffect(node: TSESTree.Node): boolean {
      let child: TSESTree.Node = node;
      let parent = node.parent;
      while (parent) {
        if (
          (child.type === "ArrowFunctionExpression" ||
            child.type === "FunctionExpression") &&
          parent.type === "CallExpression" &&
          parent.arguments[0] === child &&
          isEffectCallee(parent.callee)
        ) {
          return true;
        }
        child = parent;
        parent = parent.parent;
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (isEffectCallee(node.callee)) {
          const callback = node.arguments[0];
          if (callback !== undefined && isGrow(callback)) {
            context.report({ node: callback, messageId: "growInEffect" });
          }
          return;
        }
        if (isGrow(node.callee) && insideEffect(node)) {
          context.report({ node, messageId: "growInEffect" });
        }
      },
    };
  },
});
