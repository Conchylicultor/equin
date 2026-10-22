import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/boot.ts"],
    kind: "sanctioned",
    reason:
      "Boot belongs to the page: the boot snapshot hydrates the page's own pipeline from the page's own server, before any subtree exists.",
  },
] satisfies Exemptions;
