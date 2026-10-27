import { ESLintUtils } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Is this a NODE-SIDE fetch to the app under test?
 *
 * The distinction that matters is absolute vs relative, and it is not a
 * stylistic one — it is exactly the line between marked and unmarked:
 *
 *   `fetch("/api/pages/…")`        inside `page.evaluate` — runs IN THE BROWSER.
 *                                  Marked (the context's headers apply), but the
 *                                  page request guard refuses it: page code
 *                                  reaches the app only through its transport.
 *                                  Flagged separately (`inPage`): call the API
 *                                  as the page with `pageFetch`.
 *   `fetch(`${base}/api/…`)`       runs in Node. Unmarked. This is the hole.
 *   `fetch(pathUrl("/api/…"))`     runs in Node. Unmarked. Same hole.
 *
 * A relative URL cannot be resolved by Node at all, so an absolute one is a
 * reliable signal of which side the call is on — no need to reason about
 * whether an enclosing callee is `evaluate`.
 *
 * Deliberately narrow beyond that: a `fetch` to a third-party service from an
 * e2e script is legitimate and carries no provenance question. Only the app
 * under test does, and `/api/` (or `pathUrl`) is what names it.
 */
/** A relative app path — `fetch` of it can only run in the page. */
const IN_PAGE_APP_PATH = /^\/(?:api|ws|gateway)(?:[/?]|$)/;

/**
 * Is this an IN-PAGE fetch to the app under test (a relative `/api` | `/ws` |
 * `/gateway` path, which only the browser can resolve)? The page request
 * guard refuses it at run time; this says so at lint time.
 */
function isInPageAppFetch(
  arg: TSESTree.CallExpressionArgument | undefined,
): boolean {
  if (!arg) return false;
  if (arg.type === "Literal" && typeof arg.value === "string")
    return IN_PAGE_APP_PATH.test(arg.value);
  if (arg.type === "TemplateLiteral")
    return IN_PAGE_APP_PATH.test(arg.quasis[0]?.value.cooked ?? "");
  return false;
}

function isUnmarkedNodeAppFetch(
  arg: TSESTree.CallExpressionArgument | undefined,
): boolean {
  if (!arg) return false;

  // `pathUrl(...)` builds an absolute URL against the run's target.
  if (
    arg.type === "CallExpression" &&
    arg.callee.type === "Identifier" &&
    arg.callee.name === "pathUrl"
  ) {
    return true;
  }

  if (arg.type === "TemplateLiteral") {
    const first = arg.quasis[0]?.value.raw ?? "";
    // Starts with a literal path segment → relative → browser-side. Starts with
    // an interpolation (`${base}…`) → absolute → Node-side.
    if (first.startsWith("/")) return false;
    return arg.quasis.some((q) => q.value.raw.includes("/api/"));
  }

  // A plain string can only be relative here (an absolute one would hardcode a
  // host, which `paths:no-hardcoded-paths` and the harness's own target
  // derivation already rule out), so it is browser-side.
  return false;
}

export default createRule({
  name: "no-unmarked-app-fetch",
  meta: {
    type: "problem",
    docs: {
      description:
        "In e2e scripts, call the app under test through `agentFetch` (as the script) or `pageFetch` (as the page) rather than a bare `fetch`: a Node-side one carries no agent-origin provenance, and an in-page one is refused by the page request guard.",
    },
    schema: [],
    messages: {
      unmarked:
        "A bare `fetch` to the app under test carries no agent-origin header, so " +
        "everything it writes is invisible to the machinery that cleans up after a " +
        "run: a page it creates is never swept, and a config document it writes is " +
        "not recorded in the revert ledger and stays changed in the user's config " +
        "after the script exits. The script still goes green. `withBrowser` marks " +
        "the browser CONTEXT, which cannot cover a request the script makes from " +
        "Node — that is this gap. Use `agentFetch(path, init?)` from " +
        "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e, which applies " +
        "the headers and resolves `path` against the same `--url` target.",
      inPage:
        "An in-page `fetch` of the app's own API is refused at run time by the " +
        "page request guard (primitives/networking/plugins/request-guard): page " +
        "code reaches the server only through its transport. Call the API AS THE " +
        "PAGE from the script's side instead — `pageFetch(page, path, init?)` " +
        "from @plugins/framework/plugins/tooling/plugins/e2e-harness/e2e, over " +
        "Playwright's `page.request` (the context's cookies and agent-origin " +
        "headers), answering a standard `Response`.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Scoped to e2e by filename rather than by config, because the rule is
    // `enforceEverywhere` (contributed rules are otherwise off in e2e files) and
    // the claim is specific to e2e: a `fetch` to `/api/` from server code is an
    // ordinary internal call with no provenance question, and web code is
    // already covered by `endpoints/no-raw-web-fetch`.
    if (!context.filename.includes("/e2e/")) return {};

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier") return;
        if (node.callee.name !== "fetch") return;
        if (isInPageAppFetch(node.arguments[0])) {
          context.report({ node, messageId: "inPage" });
          return;
        }
        if (!isUnmarkedNodeAppFetch(node.arguments[0])) return;
        context.report({ node, messageId: "unmarked" });
      },
    };
  },
});
