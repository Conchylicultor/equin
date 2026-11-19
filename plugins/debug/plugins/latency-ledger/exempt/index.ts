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
    rule: "networking/no-page-transport",
    paths: ["web/internal/client-ledger.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: the latency ledger's samples always reach the page's own server (D3).",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/daily.ts"],
    kind: "sanctioned",
    reason:
      "The day rollup is INSERT … SELECT over the minute table (each day's histograms summed element-wise with unnest / array_agg, minutes counted by class): drizzle's insert builder takes values, not a select of this shape. Its columns are the declared ones in tables.ts.",
  },
] satisfies Exemptions;
