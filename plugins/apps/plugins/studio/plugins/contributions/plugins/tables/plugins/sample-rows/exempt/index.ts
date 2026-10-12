import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "The loader samples ANY public relation the reader names (`SELECT * … LIMIT 10`), and the change feed covers only some: views, derived-table rollups and `ExcludeFromChangeFeed` tables never fire, so a `db` read-set would leave their samples frozen while labelled fresh. Served as an external snapshot instead: re-read whenever a reader asks, with a Refresh affordance.",
  },
] satisfies Exemptions;
