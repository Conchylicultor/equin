import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/config.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["machine/internal/pg-driver.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "Calls a *Sync helper (or a sync child process) that has no async twin yet; blocks the backend's thread for as long as the disk or the child takes.",
  },
  {
    // Declared here, on the parent: pglite is a host provider, which holds no
    // exempt/ of its own (host-services:provider-placement).
    rule: "sql-writes:fit:dynamic",
    paths: ["plugins/pglite/server/internal/pglite-driver.ts"],
    kind: "sanctioned",
    reason:
      "A generator over the catalog: shifts every timestamp column of every table the snapshot holds (read from information_schema), so its table and column names are data, not source.",
  },
] satisfies Exemptions;
