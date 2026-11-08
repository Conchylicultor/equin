import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:dynamic",
    paths: ["cli/databases.ts"],
    kind: "sanctioned",
    reason:
      "A generator over the catalog: rewrites old data-root paths in every text column that holds one, names read from the database being migrated.",
  },
] satisfies Exemptions;
