import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** Repo areas a string can start with to name a file or folder of the repo. */
const REPO_PATH_PREFIXES = ["plugins/", "research/", "cli/"];

/**
 * Only `check/` and `lint/` folders of a plugin — where a rule's "who may
 * violate me" list used to live. The folder directly under a plugin root, so a
 * plugin NAMED `check` (`plugins/check/exempt/…`) is not mistaken for one.
 */
const IN_SCOPE = /(^|\/)(?<!plugins\/)(check|lint)\//;

/**
 * A specific file or folder: past the bare prefix, and not a glob or git
 * pathspec (`plugins/**\/package.json`, `:(exclude)…`), which describe a scan,
 * not a member of an allowlist.
 */
function isSpecificRepoPath(value: unknown): boolean {
  return (
    typeof value === "string" &&
    REPO_PATH_PREFIXES.some(
      (p) => value.startsWith(p) && value.length > p.length,
    ) &&
    !/[*?[\]{}]/.test(value)
  );
}

/**
 * A `.startsWith` test of a repo path. The bare root `"plugins/"` is "is this
 * a plugin file", which no allowlist can be, so it is not flagged; the bare
 * `"research/"` and `"cli/"` are file categories and are.
 */
function isPathTest(value: unknown): boolean {
  return isSpecificRepoPath(value) || value === "research/" || value === "cli/";
}

function literalString(node: TSESTree.Node | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * A rule or check must not carry its own list of the files that may violate it.
 * That list is the exempted plugin's to declare, in its `exempt/index.ts`; a
 * rule that exempts whole kinds of file declares `outOfScope` categories.
 * Reported in `check/` and `lint/` files only: an array (or `new Set([...])`)
 * holding a repo-path string, and a `.startsWith("plugins/…")` path test.
 */
export default createRule({
  name: "no-path-allowlist",
  meta: {
    type: "problem",
    docs: {
      description:
        "A check or lint rule must not hand-roll a repo-path allowlist; the exempted plugin declares it in its own exempt/index.ts.",
    },
    schema: [],
    messages: {
      pathAllowlist:
        "Don't hand-roll a path allowlist — the exempted plugin declares it in plugins/<p>/exempt/index.ts (or a rule declares outOfScope categories).",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!IN_SCOPE.test(context.filename.replaceAll("\\", "/"))) return {};
    return {
      ArrayExpression(node: TSESTree.ArrayExpression) {
        const hit = node.elements.some(
          (el) => el !== null && isSpecificRepoPath(literalString(el)),
        );
        if (hit) context.report({ node, messageId: "pathAllowlist" });
      },
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "startsWith"
        ) {
          return;
        }
        if (isPathTest(literalString(node.arguments[0] ?? null))) {
          context.report({ node, messageId: "pathAllowlist" });
        }
      },
    };
  },
});
