import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sql-writes:fit:dynamic",
    paths: ["core/internal/define-rollup.ts", "server/internal/rebuild.ts"],
    kind: "sanctioned",
    reason:
      "The rollup compiler and its rebuild: they write each rollup table under the name and columns its defineRollup declaration gives, so the names are compiled from the declaration, not spelled.",
  },
  {
    rule: "sql-writes:fit:hand-written",
    paths: ["core/internal/define-rollup.ts", "server/internal/rebuild.ts"],
    kind: "sanctioned",
    reason:
      "The rollup compiler and its rebuild generate each rollup's writes from its defineRollup declaration (table, key and columns compiled, not spelled): a generator, the typed path's own substrate.",
  },
] satisfies Exemptions;
