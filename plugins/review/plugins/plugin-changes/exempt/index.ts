import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/push-plugin-changes.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["server/internal/plugin-tree-cache.ts"],
    kind: "sanctioned",
    reason:
      "Reads OTHER checkouts (main and the reviewed worktree), each rebuilt only when that checkout's git state moves: each rebuild is its own pass.",
  },
] satisfies Exemptions;
