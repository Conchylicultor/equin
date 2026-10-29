import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import { isPeekCall } from "./no-render-phase-peek";

/**
 * no-laundered-peek
 *
 * Bans an exported module-scope function that RETURNS a value derived from an
 * imperative sink sample, under a value-shaped name:
 *
 *   export function canNavigateApp() {
 *     return appNavSink.peek() !== null;                    // ← a bare forward
 *   }
 *   export function placementIsNewTabFollows(id: string) {
 *     return placementSink.peek()?.newTabFollows.has(id) ?? false;  // ← derived
 *   }
 *
 * The first shape is how the original incident was actually spelled; the second
 * is the shape the repo audit turned up, and is the same hazard one derivation
 * deeper. Both read at the call site like a plain fact about the world, so
 * nothing about them says "this answer was sampled once, from a slot that gets
 * filled one commit from now". A wrapper like this defeats
 * `no-render-phase-peek` in exactly one hop: the peek is no longer syntactically
 * inside the component, so the render walk never sees it, and the stale render
 * read gets written without ever looking like one.
 *
 * Three fixes, best first:
 *   1. Make it a PURE function that TAKES the installed value as an argument —
 *      then it cannot sample at all, and its caller must obtain the value
 *      through whichever path is right for its context.
 *   2. On a render path, publish and use the sink's subscribing `use…()` hook.
 *   3. If an imperative sample really is what callers want, name it `peek…` so
 *      `no-render-phase-peek` sees it at every call site.
 *
 * DETECTION — deliberately narrow (plugin rules run repo-wide as `error`, so a
 * false positive breaks the build):
 *
 *   The function must be EXPORTED and at MODULE scope (a `FunctionDeclaration`
 *   under `export`, or `export const f = () => …` / `= function () {…}`), its
 *   name must NOT already be `/^peek/` or a hook `/^use[A-Z]/`, and at least one
 *   of its RETURNED EXPRESSIONS must CONTAIN a peek call in its subtree.
 *
 *   "Returned expression" means the expression body of a concise arrow, or the
 *   argument of a `ReturnStatement` belonging to THIS function directly — the
 *   walk into the body does not descend into nested functions. The subtree scan
 *   of a returned expression likewise stops at any function boundary, so
 *   `return () => sink.peek()` is NOT flagged: the returned closure peeks when
 *   it is later called, in whatever context calls it, which is the deferred
 *   case this rule has nothing to say about.
 *
 * A function that ACTS on a peeked value and returns nothing
 * (`export function navigateApp(url) { appNavSink.peekOrThrow()(url); }`) is not
 * laundering the sample into a value, and is not flagged.
 */

const createRule = lintRuleCreator(import.meta.url);

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFunctionType(type: string): boolean {
  return (
    type === "FunctionDeclaration" ||
    type === "FunctionExpression" ||
    type === "ArrowFunctionExpression"
  );
}

/**
 * Walk a subtree, stopping at every function boundary, calling `onNode` for each
 * node visited. The boundary stop is what keeps a returned closure's body out of
 * the scan.
 */
function walkOutsideFunctions(
  root: unknown,
  onNode: (node: TSESTree.Node) => void,
): void {
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    const rec = n as Record<string, unknown> & { type?: string };
    if (typeof rec.type !== "string") return;
    if (isFunctionType(rec.type)) return;
    onNode(rec as unknown as TSESTree.Node);
    for (const key of Object.keys(rec)) {
      if (
        key === "parent" ||
        key === "type" ||
        key === "loc" ||
        key === "range"
      )
        continue;
      visit(rec[key]);
    }
  };
  visit(root);
}

/** Does this returned expression's own subtree (no nested functions) peek? */
function containsPeekCall(expr: TSESTree.Node): boolean {
  let found = false;
  walkOutsideFunctions(expr, (node) => {
    if (!found && isPeekCall(node)) found = true;
  });
  return found;
}

/**
 * The expressions this function itself returns. Never descends into a nested
 * function — a closure that peeks when called later is not this function's
 * return value.
 */
function ownReturnedExpressions(fn: FunctionNode): TSESTree.Node[] {
  if (fn.body.type !== "BlockStatement") return [fn.body];
  const out: TSESTree.Node[] = [];
  walkOutsideFunctions(fn.body, (node) => {
    if (node.type !== "ReturnStatement") return;
    if (node.argument) out.push(node.argument);
  });
  return out;
}

/** Names that are already honest about being a one-shot sample, or are hooks. */
function isExemptName(name: string): boolean {
  return /^peek/.test(name) || /^use[A-Z]/.test(name);
}

export default createRule({
  name: "no-laundered-peek",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow an exported function that returns a value derived from an " +
        "imperative sink sample (`peek…()`) under a value-shaped name — it " +
        "hides a one-shot read from `no-render-phase-peek`.",
    },
    schema: [],
    messages: {
      launderedPeek:
        "`{{name}}` hides a one-shot sink sample behind a value-shaped name. " +
        "That is how a stale render read gets written without looking like " +
        "one: callers cannot tell the answer was sampled once, before the " +
        "installer's effect ran. Best: make this a pure function that TAKES " +
        "the installed value as an argument, so it cannot sample at all. " +
        "Otherwise read the sink's subscribing `use…()` hook on render paths, " +
        "or rename this to `peek…` so every call site is visible to " +
        "`install-sink/no-render-phase-peek`.",
    },
  },
  defaultOptions: [],
  create(context) {
    function check(fn: FunctionNode, id: TSESTree.Identifier): void {
      if (isExemptName(id.name)) return;
      for (const expr of ownReturnedExpressions(fn)) {
        if (!containsPeekCall(expr)) continue;
        context.report({
          node: id,
          messageId: "launderedPeek",
          data: { name: id.name },
        });
        return;
      }
    }

    return {
      // `export function f() { … }`
      "ExportNamedDeclaration > FunctionDeclaration"(
        node: TSESTree.FunctionDeclaration,
      ) {
        if (node.parent.parent?.type !== "Program") return;
        if (!node.id) return;
        check(node, node.id);
      },
      // `export const f = () => …` / `export const f = function () { … }`
      "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator"(
        node: TSESTree.VariableDeclarator,
      ) {
        if (node.parent.parent.parent?.type !== "Program") return;
        if (node.id.type !== "Identifier" || !node.init) return;
        const init = node.init;
        if (
          init.type !== "ArrowFunctionExpression" &&
          init.type !== "FunctionExpression"
        ) {
          return;
        }
        check(init, node.id);
      },
    };
  },
});
