import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "The loader reads only Postgres's catalogs and statistics views (`information_schema.tables`, `pg_stat_user_tables`), which the change feed cannot see — it triggers `public` tables — so a `db` read-set would be empty and never fire. Served as an external snapshot instead: the estimate is re-read whenever a reader asks.",
  },
] satisfies Exemptions;
