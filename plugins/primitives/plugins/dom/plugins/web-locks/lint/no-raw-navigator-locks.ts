import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-navigator-locks
 *
 * `navigator.locks` is absent in some contexts of browsers that otherwise have
 * Web Locks (iOS Lockdown Mode, in-app webviews, insecure origins, some worker
 * kinds): a bare `navigator.locks.request(…)` there throws "undefined is not
 * an object" (equin.ai's demo worker on Safari). Lock through `webLocks()`
 * from `@plugins/primitives/plugins/dom/plugins/web-locks/core`, whose
 * `unsupported` arm has no lock manager.
 *
 * Flags `navigator.locks` (also through a cast, `(navigator as X).locks`, or
 * `globalThis.navigator` / `self.navigator` / `window.navigator`) and the
 * hand-rolled check `"locks" in navigator`.
 */

const createRule = lintRuleCreator(import.meta.url);

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

/** The expression under casts, non-null assertions and `satisfies`. */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.type === "TSAsExpression" ||
    n.type === "TSNonNullExpression" ||
    n.type === "TSSatisfiesExpression" ||
    n.type === "TSTypeAssertion"
  )
    n = n.expression;
  return n;
}

function propertyName(node: TSESTree.MemberExpression): string | null {
  const p = node.property;
  if (!node.computed) return p.type === "Identifier" ? p.name : null;
  return p.type === "Literal" && typeof p.value === "string" ? p.value : null;
}

function isNavigator(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === "Identifier") return n.name === "navigator";
  if (n.type !== "MemberExpression" || propertyName(n) !== "navigator")
    return false;
  const obj = unwrap(n.object);
  return obj.type === "Identifier" && GLOBAL_OBJECTS.has(obj.name);
}

export default createRule({
  name: "no-raw-navigator-locks",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw navigator.locks — lock through webLocks() from " +
        "@plugins/primitives/plugins/dom/plugins/web-locks/core, which is unsupported where the context has no Web Locks.",
    },
    schema: [],
    messages: {
      noRawNavigatorLocks:
        "Raw navigator.locks crashes where the context has no Web Locks (iOS Lockdown Mode, in-app webviews, " +
        "some workers: 'undefined is not an object'). Use webLocks() from " +
        "@plugins/primitives/plugins/dom/plugins/web-locks/core and branch on its kind.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node: TSESTree.MemberExpression) {
        if (propertyName(node) !== "locks" || !isNavigator(node.object)) return;
        context.report({ node, messageId: "noRawNavigatorLocks" });
      },
      BinaryExpression(node: TSESTree.BinaryExpression) {
        if (
          node.operator === "in" &&
          node.left.type === "Literal" &&
          node.left.value === "locks" &&
          isNavigator(node.right)
        )
          context.report({ node, messageId: "noRawNavigatorLocks" });
      },
    };
  },
});
