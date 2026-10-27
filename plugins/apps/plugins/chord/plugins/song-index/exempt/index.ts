import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/loops-resource.ts"],
    kind: "sanctioned",
    reason:
      "chord.loops answers one random sample of loop windows per question, and every question carries its refill's own `round` nonce: an answer is frozen by design (`fixed` — the trainer's next refill, or its retry after `not-ready`, asks a new round), so no write to the index may move a sample already asked. Its loader reads the bulk-loaded index tables and the index status, and fills the idempotent oEmbed video-status cache.",
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
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/backup-source.ts",
      "server/internal/load-job.ts",
      "server/internal/snapshot.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
