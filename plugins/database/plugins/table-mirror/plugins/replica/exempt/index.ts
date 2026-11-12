import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/schema-sink.ts"],
    kind: "sanctioned",
    reason:
      "A replica's tables live in a schema named per replica and are made LIKE the local table at runtime, so no drizzle handle exists for them: rows are applied set-based from the page's jsonb (jsonb_populate_recordset), and a local rebuild copies the old table's columns into the new one.",
  },
  {
    rule: "sql-writes:fit:dynamic",
    paths: ["server/internal/schema-sink.ts"],
    kind: "sanctioned",
    reason:
      "The target is <replica schema>.<mirrored table> and the columns are the ones both sides have, computed from the declaration and the catalog at apply time.",
  },
  {
    rule: "imperative-create-table-allowlisted",
    paths: ["server/internal/schema-sink.ts"],
    kind: "sanctioned",
    reason:
      "A replica's tables are created in its own tm_* schema, never in public (the allowlist covers imperative PUBLIC tables, the ones orphaned-db-tables would flag); dropReplica and sweepOrphanReplicaSchemas own their removal.",
  },
] satisfies Exemptions;
