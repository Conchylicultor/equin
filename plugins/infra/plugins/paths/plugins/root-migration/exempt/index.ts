import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:dynamic",
    paths: ["cli/databases.ts"],
    kind: "sanctioned",
    reason:
      "A generator over the catalog: rewrites old data-root paths in every text column that holds one, names read from the database being migrated.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["cli/databases.ts"],
    kind: "sanctioned",
    reason:
      "The data-root migration rewrites every column of every database that holds the old root path, found through the catalog: a generator over computed names, run once with the app stopped.",
  },
] satisfies Exemptions;
