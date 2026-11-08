import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:dynamic",
    paths: ["server/internal/define-extension.ts"],
    kind: "sanctioned",
    reason:
      "upsertQuery's guarded form (onlyIf) builds its INSERT … SELECT from the table's own columns: the given ones, never the key's timestamps (refused at runtime, and absent from its value type).",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["server/internal/define-extension.ts"],
    kind: "sanctioned",
    reason:
      "The extension handle's guarded upsertQuery (INSERT … SELECT … WHERE onlyIf ON CONFLICT DO UPDATE) — the typed path other plugins call, compiled from the extension's declared columns. It must return plain SQL so a caller can embed it as an arm of a data-modifying CTE (writeAtomically), which a drizzle builder's own execution does not give.",
  },
] satisfies Exemptions;
