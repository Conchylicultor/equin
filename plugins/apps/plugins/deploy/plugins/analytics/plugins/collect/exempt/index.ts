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
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/collect.ts", "server/internal/request-context.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/instance.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: page-view analytics belong to the page and reach the page's own server (D3).",
  },
] satisfies Exemptions;
