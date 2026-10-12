import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/served.ts"],
    kind: "sanctioned",
    reason:
      "The loader reads only Postgres's catalogs (`information_schema` / `pg_catalog`), which the change feed cannot see — it triggers `public` tables — so a `db` read-set would be empty and never fire. Served external `fixed` instead: the schema is migrated at boot, before any read, and no DDL runs mid-process.",
  },
] satisfies Exemptions;
