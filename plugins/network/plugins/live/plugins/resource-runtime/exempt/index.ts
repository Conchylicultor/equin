import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "resource-runtime:compiled-routes",
    paths: ["core/routing.ts", "core/index.ts"],
    kind: "sanctioned",
    reason: "The minters' definition and the public re-export of them.",
  },
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).",
  },
] satisfies Exemptions;
