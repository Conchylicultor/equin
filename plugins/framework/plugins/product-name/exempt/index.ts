import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "product-name:legacy",
    paths: ["core/internal/product-name.ts", "check/index.ts"],
    kind: "sanctioned",
    reason: "The owner of the legacy-name list, the check that bans it.",
  },
] satisfies Exemptions;
