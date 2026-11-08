import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["machine/internal/run-terminal.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "Calls a *Sync helper (or a sync child process) that has no async twin yet; blocks the backend's thread for as long as the disk or the child takes.",
  },
] satisfies Exemptions;
