import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** `unrouteAll({ behavior: … })` — an explicit choice, rather than the unsafe default. */
function hasExplicitBehavior(args: TSESTree.CallExpressionArgument[]): boolean {
  const first = args[0];
  if (first?.type !== "ObjectExpression") return false;
  return first.properties.some(
    (p) =>
      p.type === "Property" &&
      ((p.key.type === "Identifier" && p.key.name === "behavior") ||
        (p.key.type === "Literal" && p.key.value === "behavior")),
  );
}

export default createRule({
  name: "no-unroute",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow tearing down a Playwright route that may still be running — " +
        "`unroute()`, and `unrouteAll()` without an explicit `behavior`.",
    },
    schema: [],
    messages: {
      unroute:
        "`unroute()` does not wait for route handlers that are already running. " +
        "Removing the last handler makes Playwright continue the paused request " +
        "immediately (silently cutting a stall short), and the running handler's " +
        "eventual `route.continue()` throws `Route is already handled!` as an " +
        "unhandled rejection. A verification script built on this goes GREEN " +
        "while measuring nothing. Use `stallRoute()` from " +
        "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e — it ends the " +
        "stall on a signal (`release()`) instead of a teardown, so there is " +
        "nothing to race.",
      unrouteAllDefault:
        "`unrouteAll()` defaults to `behavior: 'default'`, which does NOT wait " +
        "for handlers already running — same trap as `unroute()`. Pass an " +
        "explicit `behavior` ('wait' to drain them, 'ignoreErrors' to abandon " +
        "them), or prefer `stallRoute()` from " +
        "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e, which needs " +
        "no teardown at all.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression") return;
        if (callee.property.type !== "Identifier") return;
        const method = callee.property.name;
        if (method === "unroute") {
          context.report({ node, messageId: "unroute" });
          return;
        }
        if (method === "unrouteAll" && !hasExplicitBehavior(node.arguments)) {
          context.report({ node, messageId: "unrouteAllDefault" });
        }
      },
    };
  },
});
