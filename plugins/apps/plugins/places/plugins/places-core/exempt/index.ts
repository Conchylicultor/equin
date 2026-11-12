import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "investigate:failures-registered",
    paths: ["core/internal/resources.ts"],
    kind: "sanctioned",
    reason:
      "`businessStatus` tints Permanently closed destructive so a closed place stands out on the map and in the list, but a place Google reports closed is a fact about the world, not a failure someone must act on: there is nothing for an agent to investigate.",
  },
] satisfies Exemptions;
