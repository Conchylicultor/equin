import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The name of the one directory every hand-written build-output deny-list
 * begins with, and the names it is paired with. A list containing
 * `"node_modules"` AND at least one of these is a deny-list — nobody writes that
 * pair for any other reason.
 *
 * Requiring the PAIR is what keeps the rule precise. Plenty of code mentions
 * `"node_modules"` alone for a legitimate reason (building a path into it,
 * testing whether one specifier resolves there); it is the enumeration of
 * *several* build-output directory names together that says "I am about to walk
 * the repo and decide for myself what counts as source".
 */
const ANCHOR = "node_modules";
const COMPANIONS = new Set([
  "dist",
  ".git",
  "build",
  ".cache",
  ".next",
  "out",
  "coverage",
]);

/** The string literal elements of an array literal / `new Set([...])` argument. */
function stringElements(node: TSESTree.Node): string[] {
  if (node.type !== "ArrayExpression") return [];
  const out: string[] = [];
  for (const el of node.elements) {
    if (el?.type === "Literal" && typeof el.value === "string")
      out.push(el.value);
  }
  return out;
}

/** Is this the `["node_modules", "dist", …]` shape of a build-output deny-list? */
function isDenyList(values: string[]): boolean {
  if (!values.includes(ANCHOR)) return false;
  return values.some((v) => COMPANIONS.has(v));
}

export default createRule({
  name: "no-adhoc-repo-walk",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-written lists of build-output directory names used to " +
        "decide what counts as a source file. Ask git via listRepoFiles.",
    },
    schema: [],
    messages: {
      adhocRepoWalk:
        "This is a hand-written list of build-output directories, which is a " +
        "guess at what `.gitignore` already states exactly. Every copy of this " +
        "list has been wrong: the one in type-check omitted `.cache/`, so a " +
        "`.ts` file left in that gitignored directory counted as source, " +
        "belonged to no tsconfig program, and failed the coverage gate. Inside " +
        "a check's run(ctx), use ctx.repo() — the run's own shared file set, " +
        "loaded once and reused by every check, so this never re-lists. " +
        "Outside a check (no ctx in scope), use listRepoFiles from " +
        "@plugins/framework/plugins/tooling/plugins/checks/core, which asks git " +
        "for the same tracked + untracked-not-ignored file set. If this list is not " +
        "enumerating the repo's sources — a bounded walk of one known subtree — " +
        "declare the file in its plugin's `exempt/index.ts` so the exemption is " +
        "reviewed rather than invisible.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // `const IGNORED = ["node_modules", "dist", ".git"]` — a bare array.
      ArrayExpression(node) {
        // A `new Set([...])` is reported by the NewExpression branch below,
        // which points at the more meaningful node — so skip the inner array
        // there, and only there.
        if (node.parent.type === "NewExpression") return;
        if (isDenyList(stringElements(node))) {
          context.report({ node, messageId: "adhocRepoWalk" });
        }
      },
      // `new Set(["node_modules", "dist", ".git"])` — the common spelling.
      NewExpression(node) {
        const [arg] = node.arguments;
        if (arg && isDenyList(stringElements(arg))) {
          context.report({ node, messageId: "adhocRepoWalk" });
        }
      },
    };
  },
});
