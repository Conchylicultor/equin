import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "Phase-1 baseline of the unified prefixed ids: this table's `id` primary key names no id kind yet. Declare the kind (`defineIdKind`) and key the table with `idColumn` / `idKindField` (or `externalIdColumn` for an id minted elsewhere) in its migration phase, then delete this entry.",
  },
  {
    rule: "investigate:failures-registered",
    paths: ["core/resources.ts"],
    kind: "sanctioned",
    reason:
      "A failed model call is evidence of its CALLER's failure (an event run's extraction, a task title), investigated where the caller records it — the call log is the record an investigation reads, not the failure to file one about.",
  },
] satisfies Exemptions;
