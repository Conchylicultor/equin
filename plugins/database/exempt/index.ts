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
    // Declared here, on the parent: pglite is a host provider, which holds no
    // exempt/ of its own (host-services:provider-placement).
    rule: "sql-writes:fit:dynamic",
    paths: ["plugins/pglite/server/internal/pglite-driver.ts"],
    kind: "sanctioned",
    reason:
      "A generator over the catalog: shifts every timestamp column of every table the snapshot holds (read from information_schema), so its table and column names are data, not source.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["plugins/pglite/server/internal/pglite-driver.ts"],
    kind: "sanctioned",
    reason:
      "PGlite's clock shift rewrites every timestamp column the catalog lists, by name: a generator over the catalog, not a write to a declared table.",
  },
] satisfies Exemptions;
