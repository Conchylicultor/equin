import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "events/no-raw-events-write",
    paths: ["server/internal/events-repo.ts"],
    kind: "sanctioned",
    reason:
      "`events-repo.ts` IS the funnel — it owns the sighting stamps and write shapes every other writer must route through.",
  },
] satisfies Exemptions;
