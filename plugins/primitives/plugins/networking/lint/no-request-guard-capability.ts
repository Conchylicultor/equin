import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * no-request-guard-capability
 *
 * The page request guard (`networking/plugins/request-guard`) refuses every
 * raw same-origin `/api` | `/ws` | `/gateway` request page code issues; its
 * natives are the way past it. A module importing one could reach the app's
 * server outside every transport — exactly the request the guard exists to
 * refuse — so who may hold the capability is bounded here, each sanctioned
 * holder declared in its own `exempt/index.ts` (`kind: "sanctioned"`, no debt,
 * no inline disable):
 *
 * - `nativeFetch` — the page transport's `fetch`;
 * - `nativeWebSocket` — the per-tab reconnecting socket;
 * - `allowAssetRoute` — the asset URL resolver (`assetUrlOver`) and the app
 *   entry (the asset mirror's prefix);
 * - `installRequestGuard` — the app entry.
 *
 * `RawApiRequestError` and `requestGuardReportSink` are public: catching or
 * filing a refusal is not a way past it. A namespace import, a re-export and
 * a dynamic `import()` of the barrel would hand out every name, so each is
 * flagged as a whole.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

const REQUEST_GUARD =
  "@plugins/primitives/plugins/networking/plugins/request-guard/web";

const CAPABILITIES: readonly string[] = [
  "nativeFetch",
  "nativeWebSocket",
  "allowAssetRoute",
  "installRequestGuard",
];

const isGuard = (source: TSESTree.Node | null | undefined): boolean =>
  source?.type === "Literal" && source.value === REQUEST_GUARD;

export default createRule({
  name: "no-request-guard-capability",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing the page request guard's natives (nativeFetch, nativeWebSocket, allowAssetRoute, installRequestGuard) outside their sanctioned holders.",
    },
    schema: [],
    messages: {
      capability:
        "`{{name}}` is a way past the page request guard: a request through it " +
        "reaches the app's server outside every transport. Page code reads " +
        "server data with useLive / useLiveReader and writes through " +
        "fetchEndpoint / useEndpointMutation — the transport is the one channel. " +
        "Only the app's own channels (the page transport, the per-tab socket, " +
        "the asset URL resolver, the app entry) hold it, each declared as a " +
        '`kind: "sanctioned"` entry for `networking/no-request-guard-capability` ' +
        "in its plugin's `exempt/index.ts`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const report = (node: TSESTree.Node, name: string) =>
      context.report({ node, messageId: "capability", data: { name } });
    return {
      ImportDeclaration: (node) => {
        if (!isGuard(node.source)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier") {
            report(spec, "* as");
          } else if (
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            CAPABILITIES.includes(spec.imported.name)
          ) {
            report(spec, spec.imported.name);
          }
        }
      },
      ExportNamedDeclaration: (node) => {
        if (!isGuard(node.source)) return;
        for (const spec of node.specifiers) {
          const name =
            spec.local.type === "Identifier" ? spec.local.name : "export";
          if (CAPABILITIES.includes(name)) report(spec, name);
        }
      },
      ExportAllDeclaration: (node) => {
        if (isGuard(node.source)) report(node, "export *");
      },
      ImportExpression: (node) => {
        if (isGuard(node.source)) report(node, "import()");
      },
    };
  },
});
