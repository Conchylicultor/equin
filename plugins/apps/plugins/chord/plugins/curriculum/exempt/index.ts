import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/loops-resource.ts"],
    kind: "sanctioned",
    reason:
      "chord.curriculum.loops answers one random sample of loop windows per question, and every question carries its refill's own `round` nonce: an answer is frozen by design (`fixed`), so no write may move a sample already asked. Its loader reads the stored selection once per question (a selection change moves the trainer's palette, which drops the pool drawn for the old one) and the song index through song-index's answerLoopFind.",
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
