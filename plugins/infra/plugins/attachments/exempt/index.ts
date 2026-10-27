import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/bytes.ts"],
    kind: "sanctioned",
    reason:
      "attachments.bytes is `immutable` by id: an upload always mints a new attachment row and the bytes under an id are never rewritten, so the one Postgres read (the row's blob key, by id) can never change an answer. A deletion is not healed while subscribed, which is the immutable arm's stated contract.",
  },
  {
    rule: "paths:no-hardcoded-paths",
    paths: ["server/index.ts"],
    kind: "sanctioned",
    reason:
      "Display-only string: the `~/\u2026` spelling inside the plugin's own description metadata \u2014 prose a person reads, never a path anything resolves.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "Phase-1 baseline of the unified prefixed ids: this table's `id` primary key names no id kind yet. Declare the kind (`defineIdKind`) and key the table with `idColumn` / `idKindField` (or `externalIdColumn` for an id minted elsewhere) in its migration phase, then delete this entry.",
  },
] satisfies Exemptions;
