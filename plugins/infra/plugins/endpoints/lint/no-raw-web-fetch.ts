import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-web-fetch
 *
 * Web code must talk to the server through the typed-endpoint client
 * (`fetchEndpoint` / `useEndpoint` / `useEndpointMutation` from
 * `@plugins/infra/plugins/endpoints/web`), never a raw `fetch(...)` or a
 * `fetchWithRetry(...)` wrapper. A raw web fetch evades the typed contract (no
 * shared route string, no request/response validation, no error reporting).
 *
 * Detection is NAME-based (like reactive-server-io): we flag a CallExpression
 * whose callee identifier is `fetch` or `fetchWithRetry`, a `sendBeacon(…)`
 * call, and `new XMLHttpRequest()` — every way a browser module sends a
 * request without the subtree's transport. No import resolution —
 * intentionally evadable by indirection, which is accepted. The rule fires in
 * every module a page can load: `web/`, and the `core/` / `shared/` helpers a
 * web module imports (a helper that fetches by itself reaches the page's
 * server from inside a scope just as a component would). Primitives that
 * implement a transport, and modules that run outside any page (an agent's
 * hook script), are exempted through `exempt/index.ts` in their own plugins.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** Callee names that constitute a raw web fetch. */
const RAW_FETCH_NAMES = new Set(["fetch", "fetchWithRetry", "sendBeacon"]);

/** The folders whose modules a page can load. */
const BROWSER_FOLDER_RE = /\/(?:web|core|shared)\//;

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

export default createRule({
  name: "no-raw-web-fetch",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw fetch()/fetchWithRetry() in web code — use " +
        "fetchEndpoint/useEndpoint from the endpoints primitive instead.",
    },
    schema: [],
    messages: {
      noRawWebFetch:
        "Raw {{name}}() in web code bypasses the typed-endpoint contract. Use " +
        "fetchEndpoint / useEndpoint / useEndpointMutation from " +
        "@plugins/infra/plugins/endpoints/web instead. See the endpoints " +
        "plugin CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Only modules a page can load are in scope.
    if (!BROWSER_FOLDER_RE.test(context.filename)) return {};
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const name = calleeName(node);
        if (!name || !RAW_FETCH_NAMES.has(name)) return;
        context.report({ node, messageId: "noRawWebFetch", data: { name } });
      },
      NewExpression(node: TSESTree.NewExpression) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "XMLHttpRequest"
        )
          context.report({
            node,
            messageId: "noRawWebFetch",
            data: { name: "new XMLHttpRequest" },
          });
      },
    };
  },
});
