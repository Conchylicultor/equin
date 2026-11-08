import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/client-log.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: clientLog persists to the page's own worktree logs, whatever subtree logged (D3).",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["machine/internal/file-persistence.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "Calls a *Sync helper (or a sync child process) that has no async twin yet; blocks the backend's thread for as long as the disk or the child takes.",
  },
] satisfies Exemptions;
