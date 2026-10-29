import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-location-path
 *
 * The route path must be read through `currentRoutePath()` from
 * `@plugins/primitives/plugins/pane/web` (or the pure `normalizeRoutePath()`
 * from `.../pane/core`), never raw `window.location.pathname`.
 *
 * The address bar is untrusted input, and a raw pathname carries whatever the
 * user typed or a bad link supplied. A pathname with a repeated slash fails in
 * two silent, unrelated-looking ways:
 *
 *   • As a HISTORY URL it is *scheme-relative*. `replaceState(s, "",
 *     "//agents/c/x")` resolves to `http://agents/c/x` — a different origin —
 *     and throws SecurityError, taking down boot on a deep link.
 *   • As a MATCH KEY it misses. `"//agents/c/x".startsWith("/agents/")` is
 *     false, so the URL owns no app and the deep link silently falls back to
 *     the default app.
 *
 * Both come from reading the pathname raw, which is why the fix is a single
 * canonical reader rather than a fix at either failure site.
 *
 * Detection is leaf-based (like `apps-core/no-raw-history-nav`): any
 * MemberExpression `<…>.pathname` whose object chain ends in `location`. That
 * covers `location.pathname`, `window.location.pathname`,
 * `document.location.pathname`, and `self.location.pathname` in one check.
 * `location.href` / `.search` / `.hash` are not matched — they are not route
 * paths and have no app-matching or history-URL role.
 *
 * The sanctioned reader itself and the eager boot root escape per-site via
 * `// eslint-disable-next-line pane/no-raw-location-path -- reason`; test and
 * e2e trees are exempted wholesale (see lint/index.ts).
 */

const createRule = lintRuleCreator(import.meta.url);

/** True when this expression's leaf identifier/property is `location`. */
function isLocationObject(node: TSESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "location";
  if (node.type === "MemberExpression" && node.property.type === "Identifier") {
    return node.property.name === "location";
  }
  return false;
}

export default createRule({
  name: "no-raw-location-path",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw location.pathname — use currentRoutePath() from " +
        "@plugins/primitives/plugins/pane/web so a slash-mangled URL can neither " +
        "throw on replaceState nor silently match no app.",
    },
    schema: [],
    messages: {
      noRawLocationPath:
        "Raw location.pathname is untrusted: a repeated slash makes it " +
        "scheme-relative as a history URL (SecurityError on replaceState) and " +
        "unmatchable as an app prefix. Use currentRoutePath() from " +
        "@plugins/primitives/plugins/pane/web (or normalizeRoutePath() from " +
        ".../pane/core outside the browser-reader path).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node: TSESTree.MemberExpression) {
        if (node.computed) return;
        if (node.property.type !== "Identifier") return;
        if (node.property.name !== "pathname") return;
        if (!isLocationObject(node.object)) return;
        context.report({ node, messageId: "noRawLocationPath" });
      },
    };
  },
});
