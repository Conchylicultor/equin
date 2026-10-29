import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A `git grep` reaching a command position: at the very start of the string
 * value / template quasi, or right after a shell command separator
 * (`\n`, `;`, `&`, `|`). This is the "it is being RUN as a command" signal.
 *
 * Deliberately NOT a bare `.includes("git grep")` — that would also fire on
 * prose that merely mentions the token (this rule's own message, a doc comment)
 * and on the co-located `RuleTester` test, whose invalid-case source embeds
 * `git grep` inside a JS string preceded by a `"` quote (never a shell
 * separator). Command-position anchoring keeps the detection precise and lets
 * the rule name its own banned token without self-flagging.
 */
const GIT_GREP_COMMAND = /(?:^|[\n;&|])\s*git\s+grep\b/;

/** Whether a callee is `spawn` / `spawnSync` (bare, or a member like `Bun.spawn`). */
function isSpawnCallee(callee: TSESTree.Expression): boolean {
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" &&
          callee.property.type === "Identifier"
        ? callee.property.name
        : null;
  return name === "spawn" || name === "spawnSync";
}

/**
 * Whether an argument is an argv array literal beginning with the string
 * elements `"git"` then `"grep"` — i.e. `["git", "grep", …]`. This is the exact
 * shape a hand-rolled `git grep` spawn takes (and the one `grep-code.ts` owns).
 * A `git add` / `git rev-parse` / `git write-tree` spawn does NOT match.
 */
function isGitGrepArgv(arg: TSESTree.Node): boolean {
  if (arg.type !== "ArrayExpression") return false;
  const [first, second] = arg.elements;
  return (
    first?.type === "Literal" &&
    first.value === "git" &&
    second?.type === "Literal" &&
    second.value === "grep"
  );
}

export default createRule({
  name: "no-adhoc-git-grep",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolling a bare `git grep` — it is blind to untracked " +
        "files and the check-runner scan tree. Route candidate discovery " +
        "through grepCode / listCandidateSources from checks/core.",
    },
    schema: [],
    messages: {
      adhocGitGrep:
        "Bare 'git grep' is blind to untracked files and the check-runner scan " +
        "tree, so a check using it silently misses not-yet-committed files (and " +
        "caches a PASS against content it never inspected). Use grepCode / " +
        "listCandidateSources from " +
        "@plugins/framework/plugins/tooling/plugins/checks/core instead — their " +
        "readCandidates helper is scan-tree-aware and adds --untracked in the " +
        "fallback.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // Case A: a spawn whose argv array literal begins ["git", "grep", …].
      CallExpression(node) {
        if (!isSpawnCallee(node.callee as TSESTree.Expression)) return;
        const [firstArg] = node.arguments;
        if (firstArg && isGitGrepArgv(firstArg)) {
          context.report({ node: firstArg, messageId: "adhocGitGrep" });
        }
      },
      // Case B: a string literal used as a `git grep …` shell command.
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (GIT_GREP_COMMAND.test(node.value)) {
          context.report({ node, messageId: "adhocGitGrep" });
        }
      },
      // Case B (template form): a `git grep …` command written in a template
      // literal (e.g. a shell string). Each quasi is checked independently, so
      // the command-position anchor resets at every quasi boundary.
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          const text = quasi.value.cooked ?? quasi.value.raw;
          if (GIT_GREP_COMMAND.test(text)) {
            context.report({ node: quasi, messageId: "adhocGitGrep" });
            return;
          }
        }
      },
    };
  },
});
