import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-endpoint-call
 *
 * Code that is not a page — a server, central, a machine half, the CLI, a
 * shared or core module — calls one of our endpoints through `callEndpoint`
 * (`@plugins/infra/plugins/endpoints/server`; a `shared/` module composes
 * `endpointRequest` / `readEndpointResponse` from `core`), never by hand. A hand-rolled call
 * (`fetch(url)` + `res.json() as T`) restates the contract's path, method, body
 * and answer, so a contract change breaks it at runtime with nothing to catch
 * it: when `secretsSet` started answering 204, every `setSecret` threw
 * `Unexpected end of JSON input`. Through `callEndpoint` the change is a tsc
 * error at the caller.
 *
 * Flags, in those runtimes:
 *  - a string naming one of our routes (`"/api/…"`, `` `/api/…` ``, or an
 *    absolute `…localhost…/api/…`) passed as a call argument — the path
 *    handed to a fetch wrapper or to `namespaceUrl`;
 *  - a `fetch` / `fetchWithRetry` whose URL is built from an endpoint's
 *    `.path` or `extractPath(…)` (inline, or through a `const` it reads).
 *
 * Syntactic, so evadable by indirection — the rule closes the obvious spelling.
 * Web code has its own rule (`no-raw-web-fetch`); e2e scripts drive the deployed
 * app with `agentFetch`. A genuine exception (a reply read across code
 * generations, a process that must not load zod) is an inline disable with the
 * reason.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** The runtime folders in scope: everything that runs off the page. */
const IN_SCOPE =
  /\/(server|central|machine|cli|shared|core|bin|provision|prewarm)\//;
/** Excluded even under an in-scope folder: the page, e2e and test code. */
const OUT_OF_SCOPE =
  /\/(web|e2e|__tests__|testing)\/|\.test\.tsx?$|\.spec\.tsx?$/;

/** A route of ours: `/api/<segment>…`, relative or on a local origin. */
const ROUTE_TEXT = /^\/api\/[\w-]|^https?:\/\/[^/]*localhost[^/]*\/api\/[\w-]/;

const FETCH_NAMES = new Set(["fetch", "fetchWithRetry"]);

/** An endpoint-derived path in source text: `<endpoint>.path` or `extractPath(…)`. */
const ENDPOINT_PATH_TEXT = /\.path\b|\bextractPath\(/;

function stringHead(node: TSESTree.Node): string | null {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral")
    return node.quasis[0]?.value.cooked ?? "";
  return null;
}

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
  name: "no-raw-endpoint-call",
  meta: {
    type: "problem",
    docs: {
      description:
        "Off the page, call our endpoints through callEndpoint (endpoints/server), " +
        "never a hand-rolled fetch — so a contract change is a tsc error at the caller.",
    },
    schema: [],
    messages: {
      routePath:
        "A hand-written path to one of our endpoints. Call it with " +
        "callEndpoint(endpoint, params, { origin, body?, query? }) from " +
        "@plugins/infra/plugins/endpoints/server: the path, method, body and " +
        "decoded answer then come from the endpoint's contract, so a contract " +
        "change fails tsc here instead of a runtime parse.",
      endpointFetch:
        "A raw {{name}}() to an endpoint's path. Use callEndpoint(endpoint, " +
        "params, { origin, … }) from @plugins/infra/plugins/endpoints/server, " +
        "which also decodes the reply through the endpoint's response schema.",
    },
  },
  defaultOptions: [],
  create(context) {
    const file = context.filename;
    if (!IN_SCOPE.test(file) || OUT_OF_SCOPE.test(file)) return {};
    const source = context.sourceCode;

    /** The source text a URL argument is built from, through one `const`. */
    function urlText(arg: TSESTree.Node): string {
      if (arg.type !== "Identifier") return source.getText(arg);
      const variable = source
        .getScope(arg)
        .references.find((r) => r.identifier === arg)?.resolved;
      const def = variable?.defs[0];
      if (
        def?.type === "Variable" &&
        def.parent.kind === "const" &&
        def.node.init
      ) {
        return source.getText(def.node.init);
      }
      return source.getText(arg);
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        for (const arg of node.arguments) {
          const head = stringHead(arg);
          if (head !== null && ROUTE_TEXT.test(head)) {
            context.report({ node: arg, messageId: "routePath" });
          }
        }
        const name = calleeName(node);
        const url = node.arguments[0];
        if (!name || !FETCH_NAMES.has(name) || !url) return;
        if (ENDPOINT_PATH_TEXT.test(urlText(url))) {
          context.report({ node, messageId: "endpointFetch", data: { name } });
        }
      },
    };
  },
});
