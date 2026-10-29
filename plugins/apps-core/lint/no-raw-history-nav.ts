import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-history-nav
 *
 * Navigation must go through the sanctioned `navigate(url)` from
 * `@plugins/apps-core/plugins/tabs/web`, never a raw `window.history.pushState(...)` /
 * `history.replaceState(...)`.
 *
 * With the tab model, each tab carries both an `appId` and a URL. A raw history
 * write changes the focused tab's URL while leaving its `appId` stale —
 * `useActiveApp()` (URL-driven) then resolves to a DIFFERENT app than the
 * focused tab actually is, desyncing the tab bar and the focused store's base
 * path. `navigate(url)` resolves the target app, opens-or-focuses its tab, and
 * sets the route through the live `PaneStore`, keeping `appId` and URL in sync.
 *
 * Detection is leaf-name based (like `no-raw-web-fetch`): any CallExpression
 * whose callee is a MemberExpression ending in `.pushState` / `.replaceState` —
 * one check covers BOTH `window.history.X(...)` and bare `history.X(...)`
 * (the leaf property is identical; only the object chain differs). `.back()` /
 * `.forward()` and `history.state` reads are not matched. The two sanctioned
 * low-level URL writers (the pane store's `setRoute` and apps-layout's pre-tab
 * canonicalization) are exempted through `exempt/index.ts` in the exempted plugins.
 */

const createRule = lintRuleCreator(import.meta.url);

/** History API methods that write the URL/history entry. */
const RAW_HISTORY_METHODS = new Set(["pushState", "replaceState"]);

/** The member-call's leaf method name, or null if not a member call. */
function calleeMethod(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

export default createRule({
  name: "no-raw-history-nav",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw history.pushState/replaceState — use navigate(url) from " +
        "@plugins/apps-core/plugins/tabs/web so the focused tab's appId stays in sync with the URL.",
    },
    schema: [],
    messages: {
      noRawHistoryNav:
        "Raw history.{{method}}() desyncs the focused tab's appId from the URL. " +
        "Use navigate(url) from @plugins/apps-core/plugins/tabs/web instead — it resolves the " +
        "target app, opens-or-focuses its tab, and sets the route through the " +
        "live pane store (cross-app safe).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const method = calleeMethod(node);
        if (!method || !RAW_HISTORY_METHODS.has(method)) return;
        context.report({
          node,
          messageId: "noRawHistoryNav",
          data: { method },
        });
      },
    };
  },
});
