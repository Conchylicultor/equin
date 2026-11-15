import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "resource-runtime:compiled-routes",
    paths: ["core/routing.ts", "core/index.ts"],
    kind: "sanctioned",
    reason: "The minters' definition and the public re-export of them.",
  },
] satisfies Exemptions;
