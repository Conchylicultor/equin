import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-reactive-server-io
 *
 * Tripwire for a specific class of bug: a client `useEffect` / `useLayoutEffect`
 * that performs server I/O (toast/fetch/endpoint/query mutations) while reacting
 * to SHARED SERVER STATE. Live-state pushes (useLive / useLiveRow / useResource /
 * subscribeWsStatus resources) fan out to EVERY open browser tab,
 * so an effect that reacts to such a value and calls a write/IO fires N times —
 * once per tab — duplicating the I/O.
 *
 * This is a NUDGE, not a guarantee. It is intentionally evadable by indirection,
 * and that is accepted. The detection deliberately favors FALSE NEGATIVES over
 * FALSE POSITIVES: a false positive breaks the build (plugin rules run as
 * `error`), whereas a false negative merely misses an evasive case. When we
 * cannot establish that the effect reacts to shared server state, we DO NOT
 * report.
 *
 * Conditions — all must hold for a report:
 *   (1) The call's callee (by name, NOT by import resolution) is one of:
 *       toast | fetchEndpoint | fetch | invalidateQueries | .mutate | .mutateAsync
 *   (2) The call is lexically inside the callback passed to useEffect/useLayoutEffect.
 *   (3) The effect reacts to shared server state — detected conservatively as:
 *       the effect's dependency array (or, if there is no dep array, the callback
 *       body) references at least one binding whose initializer is — directly or
 *       transitively through other local bindings — a call to a "shared-state hook":
 *       useLive | useLiveRow | useResource | subscribeWsStatus |
 *       any use*Resource(s) hook.
 */

const createRule = lintRuleCreator(import.meta.url);

/** Callee names that constitute server I/O / a side-effecting sink (condition 1). */
const SERVER_IO_NAMES = new Set([
  "toast",
  "fetchEndpoint",
  "fetch",
  "invalidateQueries",
  "mutate",
  "mutateAsync",
]);

/**
 * Hook names whose result is (or carries) shared, cross-tab server state.
 * `useLive` / `useLiveRow` are network/live's reads (a value, a collection
 * window, a grouping, an id set, one row); neither ends in `Resource`, so the
 * naming convention below cannot catch them.
 */
const SHARED_STATE_HOOK_NAMES = new Set([
  "useLive",
  "useLiveRow",
  "useResource",
  "subscribeWsStatus",
]);

/**
 * Does this hook name yield shared cross-tab server state? Matches the explicit
 * set above, plus any `use*Resource` / `use*Resources` hook by naming convention.
 */
function isSharedStateHookName(name: string): boolean {
  if (SHARED_STATE_HOOK_NAMES.has(name)) return true;
  return (
    name.startsWith("use") &&
    (name.endsWith("Resource") || name.endsWith("Resources"))
  );
}

/** Extract the simple callee name of a call, member-or-identifier. */
function calleeName(node: TSESTree.CallExpression): string | null {
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

/** Is this an effect-hook call (useEffect / useLayoutEffect)? */
function isEffectHookCall(node: TSESTree.CallExpression): boolean {
  const name =
    node.callee.type === "Identifier"
      ? node.callee.name
      : node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier"
        ? node.callee.property.name
        : null;
  return name === "useEffect" || name === "useLayoutEffect";
}

/**
 * Collect every Identifier name referenced anywhere inside a node subtree.
 * Used to (a) scan a callback body for binding references when there is no dep
 * array, and (b) follow taint transitively through a binding's initializer.
 */
function collectIdentifierNames(node: TSESTree.Node, out: Set<string>): void {
  // Lightweight recursive walk over own enumerable child nodes. We only need
  // identifier *names*, so we don't care about scope/shadowing precision here —
  // over-collecting only makes detection slightly broader, and the transitive
  // taint set is itself bounded to locally-declared shared-state bindings.
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    const rec = n as Record<string, unknown> & { type?: string };
    if (typeof rec.type !== "string") return;
    if (rec.type === "Identifier" && typeof rec.name === "string") {
      out.add(rec.name);
    }
    for (const key of Object.keys(rec)) {
      if (
        key === "parent" ||
        key === "type" ||
        key === "loc" ||
        key === "range"
      ) {
        continue;
      }
      visit(rec[key]);
    }
  };
  visit(node);
}

/**
 * Walk up from a node to find the nearest enclosing function-ish scope node
 * (where local `const`/`let`/`var` bindings live). Returns the body block we can
 * scan for VariableDeclarations.
 */
function enclosingStatements(node: TSESTree.Node): TSESTree.Statement[] | null {
  let cur: TSESTree.Node | undefined = node.parent;
  while (cur) {
    if (
      cur.type === "FunctionDeclaration" ||
      cur.type === "FunctionExpression" ||
      cur.type === "ArrowFunctionExpression"
    ) {
      if (cur.body.type === "BlockStatement") return cur.body.body;
      return null;
    }
    if (cur.type === "Program") return cur.body as TSESTree.Statement[];
    cur = cur.parent;
  }
  return null;
}

/**
 * Build a map of `bindingName -> initializer expression` for all simple
 * `const/let/var <id> = <init>` declarations in the given statement list.
 * Only simple Identifier patterns are tracked (object/array destructuring is
 * skipped — favoring false negatives).
 */
function collectBindingInitializers(
  statements: TSESTree.Statement[],
): Map<string, TSESTree.Expression> {
  const map = new Map<string, TSESTree.Expression>();
  for (const stmt of statements) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const decl of stmt.declarations) {
      if (decl.id.type === "Identifier" && decl.init) {
        map.set(decl.id.name, decl.init);
      }
    }
  }
  return map;
}

/** Does this expression contain a direct call to a shared-state hook? */
function initializerCallsSharedStateHook(expr: TSESTree.Node): boolean {
  let found = false;
  const visit = (n: unknown): void => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    const rec = n as Record<string, unknown> & { type?: string };
    if (typeof rec.type !== "string") return;
    if (rec.type === "CallExpression") {
      const name = calleeName(rec as unknown as TSESTree.CallExpression);
      if (name && isSharedStateHookName(name)) {
        found = true;
        return;
      }
    }
    for (const key of Object.keys(rec)) {
      if (
        key === "parent" ||
        key === "type" ||
        key === "loc" ||
        key === "range"
      ) {
        continue;
      }
      visit(rec[key]);
    }
  };
  visit(expr);
  return found;
}

/**
 * Compute the set of local binding names that are "tainted" by shared server
 * state — i.e. their initializer is a shared-state hook call, OR transitively
 * references another tainted binding. Iterates to a fixed point so that
 * `latest = summaries?.[0]` ← `summaries = ...result...` ← `result = useResource(...)`
 * all become tainted.
 */
function computeTaintedBindings(
  initializers: Map<string, TSESTree.Expression>,
): Set<string> {
  const tainted = new Set<string>();

  // Seed: bindings whose initializer directly calls a shared-state hook.
  for (const [name, init] of initializers) {
    if (initializerCallsSharedStateHook(init)) tainted.add(name);
  }

  // Propagate: a binding becomes tainted if its initializer references any
  // already-tainted binding name. Repeat until no change.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, init] of initializers) {
      if (tainted.has(name)) continue;
      const refs = new Set<string>();
      collectIdentifierNames(init, refs);
      for (const ref of refs) {
        if (tainted.has(ref)) {
          tainted.add(name);
          changed = true;
          break;
        }
      }
    }
  }

  return tainted;
}

/**
 * Given an effect-hook CallExpression, return the set of identifier names the
 * effect "reacts to": the dep-array entries if a dep array is present, else
 * every identifier referenced in the callback body.
 */
function effectReactiveNames(effectCall: TSESTree.CallExpression): Set<string> {
  const names = new Set<string>();
  const callback = effectCall.arguments[0];
  const deps = effectCall.arguments[1];

  if (deps && deps.type === "ArrayExpression") {
    for (const el of deps.elements) {
      if (el) collectIdentifierNames(el, names);
    }
    return names;
  }

  // No dep array → reacts to everything its body references.
  if (
    callback &&
    (callback.type === "ArrowFunctionExpression" ||
      callback.type === "FunctionExpression")
  ) {
    collectIdentifierNames(callback.body, names);
  }
  return names;
}

export default createRule({
  name: "no-reactive-server-io",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow server I/O inside a useEffect/useLayoutEffect that reacts to " +
        "shared live-state — such effects fire in every open browser tab, " +
        "duplicating the I/O.",
    },
    schema: [],
    messages: {
      reactiveServerIo:
        "Server I/O inside an effect reacting to shared live-state fires in " +
        "every open tab. Move it server-side (defineTriggerEvent/defineJob → " +
        "recordNotification), or ensure the sink is idempotent. If this is a " +
        "deliberate, idempotent client-only reaction, disable this rule on the " +
        "line with a reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        // (1) Callee must be a known server-I/O sink.
        const name = calleeName(node);
        if (!name || !SERVER_IO_NAMES.has(name)) return;

        // (2) Must be lexically inside the callback of useEffect/useLayoutEffect.
        // Walk up to the nearest effect-hook call whose FIRST argument (the
        // callback) is an ancestor of this node.
        let cur: TSESTree.Node | undefined = node.parent;
        let effectCall: TSESTree.CallExpression | null = null;
        let effectCallback: TSESTree.Node | null = null;
        while (cur) {
          if (
            (cur.type === "ArrowFunctionExpression" ||
              cur.type === "FunctionExpression") &&
            cur.parent.type === "CallExpression" &&
            cur.parent.arguments[0] === cur &&
            isEffectHookCall(cur.parent)
          ) {
            effectCall = cur.parent;
            effectCallback = cur;
            break;
          }
          cur = cur.parent;
        }
        if (!effectCall || !effectCallback) return;

        // (3) The effect must react to shared server state. Walk the enclosing
        // component/function scope, find local shared-state-tainted bindings,
        // and check whether the effect's reactive names include any of them.
        const statements = enclosingStatements(effectCall);
        if (!statements) return;
        const initializers = collectBindingInitializers(statements);
        const tainted = computeTaintedBindings(initializers);
        if (tainted.size === 0) return;

        const reactive = effectReactiveNames(effectCall);
        let reactsToShared = false;
        for (const r of reactive) {
          if (tainted.has(r)) {
            reactsToShared = true;
            break;
          }
        }
        if (!reactsToShared) return;

        context.report({ node, messageId: "reactiveServerIo" });
      },
    };
  },
});
