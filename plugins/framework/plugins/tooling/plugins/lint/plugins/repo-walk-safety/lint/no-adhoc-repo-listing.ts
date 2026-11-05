import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The functions that list the working tree (`tooling/core`'s file-set loaders
 * and checks/core's array form of them). Each call is one more whole-tree
 * `git ls-files` pair: ~22k index entries lstat'd for `--deleted`, a walk of
 * every untracked directory for `--others`.
 */
const LISTERS = new Set(["loadRepoFiles", "loadRepoSnapshot", "listRepoFiles"]);

const LS_FILES = "ls-files";

/** The array's string literal elements, by position (`null` for any other element). */
function stringElements(node: TSESTree.ArrayExpression): (string | null)[] {
  return node.elements.map((el) =>
    el?.type === "Literal" && typeof el.value === "string" ? el.value : null,
  );
}

/**
 * An argv that runs `git ls-files`: the subcommand, preceded only by what may
 * precede a git subcommand — `git` itself, global flags (`-C`,
 * `--no-optional-locks`) and non-literal elements (the git binary's path, the
 * `-C` directory). So `["git", "-C", root, "ls-files"]` (a spawn),
 * `["ls-files", …]` and `["--literal-pathspecs", "ls-files"]` (a git helper's)
 * all match, while a list of words (`["status", "ls-files", …]`, a set of
 * read-only verbs) is data, not an argv.
 */
function isLsFilesArgv(node: TSESTree.ArrayExpression): boolean {
  const strings = stringElements(node);
  const at = strings.indexOf(LS_FILES);
  if (at < 0) return false;
  return strings
    .slice(0, at)
    .every((s) => s === null || s === "git" || s.startsWith("-"));
}

function calleeName(node: TSESTree.CallExpression): string | null {
  const { callee } = node;
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
  name: "no-adhoc-repo-listing",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow listing the working tree (`git ls-files`, loadRepoFiles / " +
        "loadRepoSnapshot) outside a pass root: take the caller's file set.",
    },
    schema: [],
    messages: {
      adhocListing:
        "This lists the working tree itself ({{what}}). A check pass already " +
        "holds one listing, read off its tree snapshot: on 2026-11-05 a single " +
        "pass spawned 59 `git ls-files` (~40 s summed), most of them whole-tree " +
        "listings that lstat ~22k files each, because shared helpers and checks " +
        "each took their own. Inside a check, read `ctx.repo()` (it carries " +
        "blob ids — a `RepoSnapshot`); in a shared helper, take the caller's " +
        "`RepoFiles` / `RepoSnapshot` as a parameter, never fall back to " +
        "listing. The pass root (a `cli/` command, a `bin/` entry point, a " +
        "script) lists once and hands the set down. A listing that is " +
        "genuinely its own pass (a long-lived server rebuilding on a watcher, " +
        "a read of another checkout) is declared in its plugin's " +
        "`exempt/index.ts`, with the reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (name !== null && LISTERS.has(name)) {
          context.report({
            node,
            messageId: "adhocListing",
            data: { what: `${name}()` },
          });
        }
      },
      ArrayExpression(node) {
        if (isLsFilesArgv(node)) {
          context.report({
            node,
            messageId: "adhocListing",
            data: { what: "a `git ls-files` argv" },
          });
        }
      },
    };
  },
});
