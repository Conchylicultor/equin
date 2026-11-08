import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/host-client.ts", "shared/code-id.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["shared/revert.ts"],
    kind: "sanctioned",
    reason:
      "Runs in the agent-browser host and the backend, never in a page: it reverts a session's writes on the deploy it names by URL — no subtree, no transport.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/host-client.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "Calls a *Sync helper (or a sync child process) that has no async twin yet; blocks the backend's thread for as long as the disk or the child takes.",
  },
] satisfies Exemptions;
