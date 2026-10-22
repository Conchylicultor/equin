import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * no-page-transport
 *
 * `pageTransport` (`networking/page-transport`) is the page's own server. A
 * module that reaches for it bypasses the transport of the subtree it runs in,
 * so inside a scope pointed elsewhere (the demo's browser server) its traffic
 * would leak to the real server. Everything resolves its transport through
 * `useTransport()` (or is handed one); the app root that mounts the page's
 * transport and page-wide telemetry / boot code are the sanctioned importers,
 * each declared in its own `exempt/index.ts` (`kind: "sanctioned"`).
 *
 * Flags every import of the page-transport barrel: static, re-export, and
 * dynamic `import()` — and every named import of a capability bound to the
 * page's own server elsewhere (`PAGE_BOUND_NAMES`: live-state's page
 * pipeline accessors), which reaches the same server without naming it.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

const PAGE_TRANSPORT =
  "@plugins/primitives/plugins/networking/plugins/page-transport/web";

/**
 * Names other barrels export that hand out the page's own server without the
 * transport: the page pipeline's NotificationsClient (it observes and reads
 * over HTTP against the page's server, whatever subtree calls it). Importing
 * one is the same exemption as importing `pageTransport`.
 */
const PAGE_BOUND_NAMES: Readonly<Record<string, readonly string[]>> = {
  "@plugins/primitives/plugins/live-state/web": [
    "getNotificationsClient",
    "ensureNotificationsClient",
  ],
};

export default createRule({
  name: "no-page-transport",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing pageTransport — resolve the subtree's transport with useTransport() (or take a fetcher) so a scoped subtree never reaches the page's server.",
    },
    schema: [],
    messages: {
      noPageTransport:
        "`pageTransport` is the page's own server: code using it ignores the " +
        "transport of the subtree it runs in, so inside a scope pointed " +
        "elsewhere (the demo) it reaches the real server. A component resolves " +
        "its transport with `useTransport()` / `useFetchEndpoint()`; a helper " +
        "takes `fetchEndpoint: FetchEndpoint` (or a `Transport`) from its " +
        "caller. Only page-wide code (the app root, page telemetry, boot) may " +
        'use it — declared as a `kind: "sanctioned"` entry for ' +
        "`networking/no-page-transport` in the importing plugin's " +
        "`exempt/index.ts`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const check = (source: TSESTree.Node | null | undefined) => {
      if (source?.type === "Literal" && source.value === PAGE_TRANSPORT)
        context.report({ node: source, messageId: "noPageTransport" });
    };
    const checkNames = (
      source: TSESTree.Node | null | undefined,
      names: readonly string[],
      node: TSESTree.Node,
    ) => {
      if (source?.type !== "Literal" || typeof source.value !== "string")
        return;
      const bound = PAGE_BOUND_NAMES[source.value];
      if (bound !== undefined && names.some((n) => bound.includes(n)))
        context.report({ node, messageId: "noPageTransport" });
    };
    return {
      ImportDeclaration: (node) => {
        check(node.source);
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier"
          )
            checkNames(node.source, [spec.imported.name], spec);
        }
      },
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
});
