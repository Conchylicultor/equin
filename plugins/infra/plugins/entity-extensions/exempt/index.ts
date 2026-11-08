import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:dynamic",
    paths: ["server/internal/define-extension.ts"],
    kind: "sanctioned",
    reason:
      "upsertQuery's guarded form (onlyIf) builds its INSERT … SELECT from the table's own columns: the given ones, never the key's timestamps (refused at runtime, and absent from its value type).",
  },
] satisfies Exemptions;
