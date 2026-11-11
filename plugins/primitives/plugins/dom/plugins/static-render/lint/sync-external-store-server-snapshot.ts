import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * `useSyncExternalStore(subscribe, getSnapshot)` without its third argument
 * (`getServerSnapshot`) THROWS in a server render — and the public website is
 * rendered to static HTML (`primitives/dom/static-render`, never hydrated) from
 * the app's real components. A two-argument call fails only when the first
 * website component reaching it is snapshot-taken, far from the cause; this
 * rule makes the omission a lint error at the call.
 *
 * What to pass is a per-store decision:
 *  - usually the store's own snapshot (`getSnapshot` again): the static render
 *    is never hydrated, so there is no client/server mismatch to protect, and
 *    what the store holds now IS the truth of that render;
 *  - a store that reads a browser global (window, matchMedia, storage,
 *    navigator) must answer without it — and "not known yet" stays a
 *    loading/unknown state, never a stand-in value.
 *
 * Matches `useSyncExternalStore(...)`, a local alias imported from "react",
 * and `<ns>.useSyncExternalStore(...)`. An `undefined` / `void` third argument
 * is no server snapshot, and a spread in the first three positions hides
 * whether one is there: both are flagged.
 */
export default createRule({
  name: "sync-external-store-server-snapshot",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require useSyncExternalStore's third argument (getServerSnapshot): a two-argument call throws in a static render.",
    },
    schema: [],
    messages: {
      missingServerSnapshot:
        "useSyncExternalStore needs its third argument, getServerSnapshot: without it the call throws in a static render (the crawlable website's snapshot, primitives/dom/static-render). Usually pass the store's own snapshot (the static render is never hydrated); a store reading a browser global must answer without it, and 'not known yet' stays a loading/unknown state, never a stand-in value.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Local names bound to React's hook: `useSyncExternalStore` itself, plus
    // any alias (`import { useSyncExternalStore as useStore } from "react"`).
    const hookNames = new Set(["useSyncExternalStore"]);

    function isUseSyncExternalStore(callee: TSESTree.Expression): boolean {
      if (callee.type === "Identifier") return hookNames.has(callee.name);
      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === "useSyncExternalStore"
      );
    }

    /** An argument that is no server snapshot: `undefined` / `void 0`. */
    function isAbsent(arg: TSESTree.CallExpressionArgument): boolean {
      return (
        (arg.type === "Identifier" && arg.name === "undefined") ||
        (arg.type === "UnaryExpression" && arg.operator === "void")
      );
    }

    return {
      ImportSpecifier(node) {
        if (
          node.parent.type === "ImportDeclaration" &&
          node.parent.source.value === "react" &&
          node.imported.type === "Identifier" &&
          node.imported.name === "useSyncExternalStore"
        )
          hookNames.add(node.local.name);
      },
      CallExpression(node) {
        if (!isUseSyncExternalStore(node.callee)) return;
        // The third argument must be written out, ahead of any spread (a
        // spread hides which position it fills), and be a value.
        const third = node.arguments
          .slice(0, 3)
          .every((a) => a.type !== "SpreadElement")
          ? node.arguments[2]
          : undefined;
        if (third !== undefined && !isAbsent(third)) return;
        context.report({ node, messageId: "missingServerSnapshot" });
      },
    };
  },
});
