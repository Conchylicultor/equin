import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/user-path.ts"],
    kind: "sanctioned",
    reason:
      "The brand's own constructors: asAppPath is the claim primitive the rule polices at each call site, and joinAppPath types a join under an AppPath.",
  },
] satisfies Exemptions;
