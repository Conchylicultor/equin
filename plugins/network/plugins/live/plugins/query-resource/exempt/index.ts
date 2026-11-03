import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "resource-runtime:compiled-routes",
    paths: ["server/internal/routes.ts"],
    kind: "sanctioned",
    reason:
      "The query compilers' one minter (window / point routes, the grouping reach): it renders the SQL, so it states the columns.",
  },
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).",
  },
] satisfies Exemptions;
