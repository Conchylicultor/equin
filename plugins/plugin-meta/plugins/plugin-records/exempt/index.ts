import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "imperative-create-table-allowlisted",
    paths: ["cli/internal/sqlite-store.ts"],
    kind: "sanctioned",
    reason:
      "The plugin-record store is a SQLite file under the data root (bun:sqlite), not a table of the app's Postgres database: the allowlist and the orphaned-db-tables check it feeds are about Postgres schema.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/outside-files.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "not yet split into server/ + machine/: the module graph's disk reader of gitignored files, moved here from the four core readers that held it (faceted, codegen file-scans and evaluated-barrels), each under the same debt.",
  },
] satisfies Exemptions;
