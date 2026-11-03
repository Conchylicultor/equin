import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

// The git commands that read EVERY worktree's `.git/worktrees/<id>/` entry
// (through its `commondir`) before doing anything, and so die ("fatal: failed
// to read .git/worktrees/<other>/commondir") while any other `git worktree
// add` — ours, a spare refill, Claude Code's `agent-*` — is half-way through
// writing its entry. The worktree plugin has a crash-safe replacement for each
// (see its CLAUDE.md, "No git command here enumerates the worktrees").
const ENUMERATING_SUBCOMMANDS = new Set([
  "list",
  "add",
  "move",
  "lock",
  "unlock",
  "remove",
  "repair",
]);

// `git switch` onto an existing branch runs the same enumeration (its "already
// checked out elsewhere" refusal); these flags skip it — `-c` creates the
// branch, so there is nothing to check (`-C` resets an existing one: it checks).
const SWITCH_SAFE_FLAGS = new Set([
  "--ignore-other-worktrees",
  "--detach",
  "-c",
]);

const SUBS = [...ENUMERATING_SUBCOMMANDS].join("|");
// A command position (start, or after a shell separator / `$(`), then `git`,
// an optional `-C <dir>`, then the subcommand. Prose mentioning the command
// mid-sentence does not match.
const SHELL_PREFIX = String.raw`(?:^|[\n;&|]|\$\()\s*git(?:\s+-C\s+\S+)?\s+`;
const SHELL_WORKTREE = new RegExp(`${SHELL_PREFIX}worktree\\s+(${SUBS})\\b`);
const SHELL_SWITCH = new RegExp(
  `${SHELL_PREFIX}switch\\b(?![^\\n;&|]*\\s(?:--ignore-other-worktrees|--detach|-c)(?:\\s|$))`,
);

type Token =
  { kind: "string"; value: string } | { kind: "git" } | { kind: "other" };

function tokenOf(node: TSESTree.Node | null): Token {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value === "git"
      ? { kind: "git" }
      : { kind: "string", value: node.value };
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis[0]
  ) {
    const value = node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
    return value === "git" ? { kind: "git" } : { kind: "string", value };
  }
  // The git binary constant (`GIT` from infra/paths).
  if (node?.type === "Identifier" && node.name === "GIT")
    return { kind: "git" };
  // A spread git-argv prefix: `...checkoutGit(dir)`, `...gitArgv`.
  if (node?.type === "SpreadElement") {
    const arg = node.argument;
    const name =
      arg.type === "CallExpression" ? calleeName(arg.callee) : identName(arg);
    if (name !== null && /git/i.test(name)) return { kind: "git" };
  }
  return { kind: "other" };
}

function identName(node: TSESTree.Node): string | null {
  return node.type === "Identifier" ? node.name : null;
}

function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

// What an argv-shaped list (an array literal, or a call's arguments) runs, if
// it is one of the banned commands. `viaGit` says the list is already a git
// invocation (a `git(…)` / `gitOk(…)` helper's arguments).
function bannedCommand(tokens: Token[], viaGit: boolean): string | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (
      a.kind === "string" &&
      a.value === "worktree" &&
      b.kind === "string" &&
      ENUMERATING_SUBCOMMANDS.has(b.value)
    ) {
      return `git worktree ${b.value}`;
    }
  }
  const sw = tokens.findIndex(
    (t) => t.kind === "string" && t.value === "switch",
  );
  if (sw === -1) return null;
  const isGit = viaGit || tokens.slice(0, sw).some((t) => t.kind === "git");
  if (!isGit) return null;
  const safe = tokens.some(
    (t) => t.kind === "string" && SWITCH_SAFE_FLAGS.has(t.value),
  );
  return safe ? null : "git switch";
}

export default createRule({
  name: "no-raw-worktree-git",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban `git worktree list|add|move|lock|unlock|remove|repair` and a " +
        "`git switch` without `--ignore-other-worktrees` outside the worktree " +
        "plugin: each reads every worktree's admin entry and crashes beside a " +
        "concurrent, half-written `git worktree add`.",
    },
    schema: [],
    messages: {
      rawWorktreeGit:
        "`{{command}}` reads every worktree's `.git/worktrees/<id>/` entry and " +
        "dies ('failed to read …/commondir') while another `git worktree add` " +
        "is half-way through writing one. Use the worktree plugin's crash-safe " +
        "API (@plugins/infra/plugins/worktree/server: listWorktreeEntries / " +
        "listWorktreePaths / ensureMainWorktreeRoot, addCheckout, " +
        "removeWorktree), or pass `--ignore-other-worktrees` to a switch after " +
        "checking the branch is not checked out elsewhere. An exception " +
        "belongs in the exempted plugin's `exempt/index.ts`, with its reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    const reportList = (
      node: TSESTree.Node,
      elements: (TSESTree.Node | null)[],
      viaGit: boolean,
    ) => {
      const command = bannedCommand(elements.map(tokenOf), viaGit);
      if (command) {
        context.report({
          node,
          messageId: "rawWorktreeGit",
          data: { command },
        });
      }
    };
    const reportText = (node: TSESTree.Node, text: string) => {
      const worktree = SHELL_WORKTREE.exec(text);
      const command = worktree
        ? `git worktree ${worktree[1]}`
        : SHELL_SWITCH.test(text)
          ? "git switch"
          : null;
      if (command) {
        context.report({
          node,
          messageId: "rawWorktreeGit",
          data: { command },
        });
      }
    };
    return {
      ArrayExpression(node) {
        reportList(node, node.elements, false);
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        reportList(node, node.arguments, name !== null && /^git/i.test(name));
      },
      Literal(node) {
        if (typeof node.value === "string") reportText(node, node.value);
      },
      TemplateLiteral(node) {
        // `${GIT} worktree list`: the binary as the template's first
        // expression, the subcommand in the quasi after it.
        const [first, second] = node.quasis;
        const [expr] = node.expressions;
        if (
          first &&
          second &&
          first.value.raw.trim() === "" &&
          expr &&
          tokenOf(expr).kind === "git"
        ) {
          reportText(second, `git${second.value.cooked ?? second.value.raw}`);
          return;
        }
        for (const quasi of node.quasis) {
          reportText(quasi, quasi.value.cooked ?? quasi.value.raw);
        }
      },
    };
  },
});
