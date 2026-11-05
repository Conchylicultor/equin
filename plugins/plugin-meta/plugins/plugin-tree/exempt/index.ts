import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/plugin-tree.ts",
      "server/internal/tree-change-signal.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["server/internal/structure-tree-cache.ts"],
    kind: "sanctioned",
    reason:
      "A long-lived server's view of its own checkout, rebuilt only when the plugins-dir watcher sees a change: each rebuild is its own pass.",
  },
] satisfies Exemptions;
