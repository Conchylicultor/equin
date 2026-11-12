import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timed-fs/no-untimed-fs-read",
    paths: ["bin/bootstrap.ts"],
    kind: "sanctioned",
    reason:
      "The hook bootstrap imports only node: builtins (guards:bootstrap-builtins-only), so a mid-edit checkout cannot break every tool call; its one existsSync runs in Claude Code's short hook process, never a process whose waits are profiled.",
  },
  {
    rule: "guard-path-safety/no-adhoc-path-resolve",
    paths: ["core/guards/main-edits.ts"],
    kind: "sanctioned",
    reason:
      "This path does not derive from a shell command's arguments: main-edits guards Write/Edit (a structured `file_path` the harness supplies). A guard that wants a path out of a command belongs in `core/argv.ts` instead.",
  },
  {
    rule: "user-path/no-sync-fs",
    paths: [
      "core/context.ts",
      "core/git-target.ts",
      "core/guards/poll-loop.ts",
      "core/walk-scope.ts",
    ],
    kind: "sanctioned",
    reason:
      "PreToolUse guard run in Claude Code's hook process, never a backend's JS thread: a stat of an agent-named path can stall only that one guard call.",
  },
  {
    rule: "python/no-system-python",
    paths: ["core"],
    kind: "sanctioned",
    reason:
      "The Claude Code guards parse agents' shell commands as DATA (`python3 - <<'PY'` is a command they classify, never run), and poll-detect lists interpreter names to recognise.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/agent-ops.ts",
      "core/argv.ts",
      "core/context.ts",
      "core/git-target.ts",
      "core/informed-once.ts",
      "core/guards/git-diff-main.ts",
      "core/guards/main-edits.ts",
      "core/guards/poll-loop.ts",
      "core/parse-shell.ts",
      "core/stop-guard.ts",
      "core/walk-scope.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "core/agent-ops.ts",
      "core/context.ts",
      "core/git-target.ts",
      "core/guards/data-root-writes.ts",
      "core/guards/git-diff-main.ts",
      "core/guards/poll-loop.ts",
      "core/informed-once.ts",
      "core/walk-scope.ts",
    ],
    kind: "sanctioned",
    reason:
      "PreToolUse / Stop guard code, run in Claude Code's own short hook process: no backend loads guards core (the constants backends read live in the guards/tool-use-id and guards/bypass-tokens leaves), held there by blocking-fs:sync-named-reach.",
  },
] satisfies Exemptions;
