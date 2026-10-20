import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "web-storage/no-raw-web-storage",
    paths: ["web/internal/store.ts"],
    kind: "sanctioned",
    reason: "The web-storage primitive is the one door to Web Storage.",
  },
] satisfies Exemptions;
