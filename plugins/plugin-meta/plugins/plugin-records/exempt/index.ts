import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "imperative-create-table-allowlisted",
    paths: ["cli/internal/sqlite-store.ts"],
    kind: "sanctioned",
    reason:
      "The plugin-record store is a SQLite file under the data root (bun:sqlite), not a table of the app's Postgres database: the allowlist and the orphaned-db-tables check it feeds are about Postgres schema.",
  },
] satisfies Exemptions;
