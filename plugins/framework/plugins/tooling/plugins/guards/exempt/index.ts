import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "guard-path-safety/no-adhoc-path-resolve",
    paths: [
      "core/guards/git-diff-main.ts",
      "core/guards/main-edits.ts",
      "core/guards/poll-loop.ts",
    ],
    kind: "sanctioned",
    reason:
      "None of these paths derive from a shell command's arguments: main-edits guards Write/Edit (a structured `file_path` the harness supplies), git-diff-main and poll-loop build their own per-session state file from `ctx.cwd` / `tmpdir()`. A guard that wants a path out of a command belongs in `core/argv.ts` instead.",
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
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
