import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "import-scan-safety/no-adhoc-import-scan",
    paths: ["core/find-imports.ts"],
    kind: "sanctioned",
    reason:
      "`findImports` is the one sanctioned home for a whole-file static-import scanner — it owns the FROM_RE / SIDE_EFFECT_RE shapes this rule forbids everywhere else.",
  },
] satisfies Exemptions;
