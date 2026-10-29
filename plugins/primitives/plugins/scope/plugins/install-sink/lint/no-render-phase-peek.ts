import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-render-phase-peek
 *
 * Bans an imperative sink sample — a call named `peek…` (`sink.peek()`,
 * `sink.peekOrThrow()`, or a bare `peekFoo()`) — that executes during React
 * render.
 *
 *   function ExpandButton() {
 *     const away = appNavSink.peek() !== null;   // ← one-shot, never updates
 *     …
 *   }
 *
 * An INSTALLED SINK is a module-level slot a higher layer installs into and a
 * lower layer calls (`pane` cannot import `tabs`, so `tabs` installs the
 * navigator into a slot `pane` owns). Installation happens at provider mount,
 * i.e. inside an EFFECT — one commit AFTER the first render of everything
 * mounted alongside it. A render-phase read therefore samples the slot before
 * anything is in it, and because the slot is in no dependency array, nothing
 * ever re-runs the read: the component keeps the pre-install answer ("nothing
 * installed") for its entire life. Whether you win or lose is mount-order luck
 * (eager vs deferred plugin tiers), so one consumer works and its neighbour is
 * silently broken.
 *
 * The correct render-path read is always a SUBSCRIPTION — the sink's
 * `useInstalled()` / `useValue()` hook. The imperative sample is correct only
 * from an event handler or an effect, which run after installation and re-run
 * on every invocation.
 *
 * DETECTION — deliberately narrow (a false positive breaks the build, since
 * plugin rules run repo-wide as `error`; a false negative merely misses an
 * exotic render-time callback):
 *
 *   From the call, walk the ancestor chain outward. At each function boundary:
 *     - a REACT function (a resolvable name matching `/^use[A-Z]/` or
 *       `/^[A-Z]/`) ⇒ REPORT — every boundary crossed to get here was
 *       render-time, so the call runs during that component's/hook's render;
 *     - a RENDER-TIME boundary ⇒ keep walking;
 *     - anything else ⇒ STOP, no report.
 *   Reaching `Program` stops with no report.
 *
 * Render-time boundaries are a CLOSED whitelist: an IIFE, `useMemo`'s callback,
 * `useState`'s initializer, `useReducer`'s third argument, and the callback of
 * an inline array-method call (`map`/`filter`/`reduce`/…). EVERY other boundary
 * — an effect callback, a `useCallback`, a closure returned from a `useMemo`, an
 * `onClick` prop — is treated as deferred and the walk stops there. Treating an
 * unrecognised boundary as deferred is the no-false-positive direction.
 *
 * Zero boundaries — a bare `peek()` sitting directly in a component body — is
 * the direct case and reports.
 *
 * The callee-name test is `/^peek([A-Z0-9_]|$)/`, so `peek`, `peekOrThrow` and
 * `peekValue` match while an unrelated `peeking()` does not: the boundary is a
 * word boundary, not a prefix, so ordinary English verbs starting with "peek"
 * are not swept in.
 */

const createRule = lintRuleCreator(import.meta.url);

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

/** Array methods whose callback argument React invokes synchronously, in render. */
const ARRAY_METHODS = new Set([
  "map",
  "flatMap",
  "filter",
  "forEach",
  "reduce",
  "reduceRight",
  "find",
  "findLast",
  "findIndex",
  "some",
  "every",
  "sort",
  "flat",
]);

/** A word-boundary `peek` prefix: `peek`, `peekOrThrow`, `peek2` — but not `peeking`. */
const PEEK_NAME = /^peek([A-Z0-9_]|$)/;

function isFunctionNode(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** The simple callee name of a call (`f()` → `f`, `a.b()` → `b`), or null. */
export function calleeName(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

/** Is this call an imperative sink sample (`x.peek()` / `peekFoo()`)? */
export function isPeekCall(
  node: TSESTree.Node,
): node is TSESTree.CallExpression {
  if (node.type !== "CallExpression") return false;
  const name = calleeName(node);
  return name !== null && PEEK_NAME.test(name);
}

/**
 * The function's own name, when one is statically resolvable: a declaration's
 * id, the id of the `VariableDeclarator` it directly initializes, or the key of
 * the `Property` / `MethodDefinition` it directly is. Anything else (a bare
 * callback argument) has no name.
 */
function functionName(fn: FunctionNode): string | null {
  if (fn.type === "FunctionDeclaration" && fn.id) return fn.id.name;
  const parent = fn.parent;
  if (
    parent.type === "VariableDeclarator" &&
    parent.init === fn &&
    parent.id.type === "Identifier"
  ) {
    return parent.id.name;
  }
  if (parent.type === "Property" && parent.value === fn) {
    if (parent.key.type === "Identifier") return parent.key.name;
    return null;
  }
  if (parent.type === "MethodDefinition" && parent.value === fn) {
    if (parent.key.type === "Identifier") return parent.key.name;
    return null;
  }
  return null;
}

/** A React component (`/^[A-Z]/`) or hook (`/^use[A-Z]/`). */
function isReactFunctionName(name: string): boolean {
  return /^use[A-Z]/.test(name) || /^[A-Z]/.test(name);
}

/**
 * Is this function a boundary React crosses DURING render? Closed whitelist —
 * anything unrecognised is treated as deferred (no report).
 */
function isRenderTimeBoundary(fn: FunctionNode): boolean {
  const parent = fn.parent;
  if (parent.type !== "CallExpression") return false;

  // IIFE: `(() => { … })()` — the function is its own call's callee.
  if (parent.callee === fn) return true;

  const name = calleeName(parent);
  if (name === "useMemo" && parent.arguments[0] === fn) return true;
  if (name === "useState" && parent.arguments[0] === fn) return true;
  if (name === "useReducer" && parent.arguments[2] === fn) return true;

  // Inline array method: `items.map((i) => …)`.
  if (
    parent.callee.type === "MemberExpression" &&
    parent.callee.property.type === "Identifier" &&
    ARRAY_METHODS.has(parent.callee.property.name) &&
    parent.arguments.some((arg) => arg === fn)
  ) {
    return true;
  }

  return false;
}

export default createRule({
  name: "no-render-phase-peek",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow an imperative sink sample (a `peek…()` call) during React " +
        "render — it samples once and never updates. Use the sink's " +
        "subscribing `use…()` hook instead.",
    },
    schema: [],
    messages: {
      renderPhasePeek:
        "`{{name}}()` samples the sink ONCE and never updates — nothing " +
        "re-runs it, because the sink is in no dependency array. Installers " +
        "run in an effect, one commit later, so this can cache " +
        '"nothing installed" for the whole life of this component. Read the ' +
        "sink's subscribing `use…()` hook from a render path; `peek…` is for " +
        "event handlers and effects, which run after installation.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (!isPeekCall(node)) return;

        let current: TSESTree.Node = node;
        for (;;) {
          const parent: TSESTree.Node | undefined = current.parent;
          if (!parent || parent.type === "Program") return;
          current = parent;
          if (!isFunctionNode(current)) continue;

          const name = functionName(current);
          if (name !== null && isReactFunctionName(name)) {
            context.report({
              node,
              messageId: "renderPhasePeek",
              data: { name: calleeName(node) ?? "peek" },
            });
            return;
          }
          if (isRenderTimeBoundary(current)) continue;
          return; // Deferred boundary — the call does not run during render.
        }
      },
    };
  },
});
