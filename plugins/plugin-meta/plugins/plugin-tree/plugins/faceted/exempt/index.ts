import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/fs-snapshot.ts", "core/internal/faceted-tree.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/internal/live-snapshot.ts"],
    kind: "sanctioned",
    reason:
      "The faceted index's live snapshot: a long-lived reader in the backend's faceted-tree worker, listed once cold and then kept up to date by the watcher's paths — its own pass, which no check pass holds.",
  },
] satisfies Exemptions;
