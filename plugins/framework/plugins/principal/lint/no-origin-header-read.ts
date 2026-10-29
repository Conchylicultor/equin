import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-origin-header-read
 *
 * Who a request is — the owner or anyone else — is decided once, at the edge:
 * the gateway reads `Origin` / `Sec-Fetch-Site` / the Host and stamps its
 * verdict as `X-Equin-Principal`, and the socket hosts gate every route on it
 * by the route's declared `access` (`framework/principal`). A handler that
 * reads those request headers itself is a second, hand-rolled answer to the
 * same question — host-fs's `isAppOrigin` was one, copied onto three routes
 * while every other route had none. So reading them is banned outside the
 * principal plugin, which owns the one narrower question left
 * (`isBrowserRequest`).
 *
 * Flags `<x>.headers.get|has|getAll("origin" | "sec-fetch-…")` and the same on
 * a binding named `headers`, the header name a string literal in any case.
 * Syntactic: a name held in a variable is not seen — the rule closes the
 * obvious spelling.
 */

const createRule = lintRuleCreator(import.meta.url);

const READERS = new Set(["get", "has", "getAll"]);
const BANNED = /^(origin|sec-fetch-[\w-]*)$/i;

function literalText(node: TSESTree.Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function isHeaders(node: TSESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "headers";
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "headers"
  );
}

export default createRule({
  name: "no-origin-header-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Never read the Origin / Sec-Fetch-* request headers in a handler: the gateway decides who a request is, and the route's declared access gates it.",
    },
    schema: [],
    messages: {
      originRead:
        'Reading the "{{name}}" request header hand-rolls who the caller is. ' +
        "The gateway already decided it (X-Equin-Principal) and every route is " +
        'owner-only unless declared `access: { public: "<reason>" }` on its ' +
        "defineEndpoint — the socket host refuses an anonymous caller before the " +
        "handler runs. Read the verdict with principalOf(req), or, for a route no " +
        "browser may call at all, isBrowserRequest(req) — both from " +
        "@plugins/framework/plugins/principal/core.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !READERS.has(callee.property.name) ||
          !isHeaders(callee.object)
        ) {
          return;
        }
        const name = literalText(node.arguments[0]);
        if (name === null || !BANNED.test(name)) return;
        context.report({ node, messageId: "originRead", data: { name } });
      },
    };
  },
});
