import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sink-safety/no-adhoc-profiler-seam",
    paths: ["."],
    kind: "sanctioned",
    reason: "Installs the ONE onSlowSpan subscriber.",
  },
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
    paths: ["web/internal/slow-op-queue.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: the client slow-op queue always reaches the page's own server (D3).",
  },
] satisfies Exemptions;
