import type { TSESTree } from "@typescript-eslint/utils";
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-claude-bin-spawn
 *
 * The Claude Code executable (`bundledClaudeBin()`, the build the Agent SDK
 * ships) is only ever handed to the Agent SDK (`claudeQuery`'s `bin`). Spawning it by hand — `claude --print`, `claude auth status` — means
 * flags spelled as strings, stdout scraped for an answer, and a session on no
 * chosen account. Every one of those reads has an SDK form: a turn
 * (`runClaudeTurn`), the version / account / model menu (`readClaudeInitialize`),
 * the usage limits (a no-prompt session's control request).
 *
 * Flags a spawn-like call (`spawn`, `spawnSync`, `spawnCaptured`, `execFile`,
 * `Bun.spawn`, …) whose argv is an array starting with `bundledClaudeBin()…`,
 * or whose first argument is that call. A read with no SDK form (signing in)
 * is a sanctioned exemption of the plugin that owns it.
 */

const SPAWNERS =
  /^(spawn|spawnSync|spawnCaptured|execFile|execFileSync|exec|execSync)$/;
const BIN_LOOKUPS = new Set(["bundledClaudeBin"]);

function calleeName(callee: TSESTree.Expression): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  )
    return callee.property.name;
  return null;
}

/** `bundledClaudeBin()` (and a member read off it). */
function isBinLookup(node: TSESTree.Node | null | undefined): boolean {
  if (!node) return false;
  if (node.type === "MemberExpression") return isBinLookup(node.object);
  if (node.type === "TSNonNullExpression") return isBinLookup(node.expression);
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    BIN_LOOKUPS.has(node.callee.name)
  );
}

export default createRule({
  name: "no-claude-bin-spawn",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow spawning the Claude Code executable by hand — open an Agent SDK session (claudeQuery) instead.",
    },
    schema: [],
    messages: {
      spawn:
        "The Claude Code executable is spawned by hand here. Open an Agent SDK " +
        "session instead — runClaudeTurn / readClaudeInitialize / claudeQuery " +
        "from @plugins/infra/plugins/claude-cli/plugins/sdk/server.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null || !SPAWNERS.test(name)) return;
        const first = node.arguments[0];
        const argv0 =
          first?.type === "ArrayExpression" ? first.elements[0] : first;
        if (argv0 && argv0.type !== "SpreadElement" && isBinLookup(argv0))
          context.report({ node: argv0, messageId: "spawn" });
      },
    };
  },
});
