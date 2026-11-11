import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "The equin shell's solo-mode chrome (the floating global action bar). The standalone website draws its own layout, and the live demo's embedded app carries its own header — the page does without it.",
  },
] satisfies Exemptions;
