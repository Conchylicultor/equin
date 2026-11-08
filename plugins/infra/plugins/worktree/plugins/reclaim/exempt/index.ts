import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/owned-namespaces.ts",
      "server/internal/reclaim-namespace.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["server/internal/reclaim-namespace.ts"],
    kind: "sanctioned",
    reason:
      "A read of another checkout: the composing checkout whose filtered registries a reclaim deletes is not this backend's, so no pass holds its file set — the plugins that own a registry are discovered from its own listing, once per reclaimed namespace.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/reclaim-namespace.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "Calls a *Sync helper (or a sync child process) that has no async twin yet; blocks the backend's thread for as long as the disk or the child takes.",
  },
] satisfies Exemptions;
