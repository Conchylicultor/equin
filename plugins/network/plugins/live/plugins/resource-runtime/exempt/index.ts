import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).",
  },
  {
    rule: "semaphore/slot-use-site",
    paths: ["core/test-support.ts"],
    kind: "sanctioned",
    reason:
      "The DB-free harness's controllable loaders model a served read's DB statement: each load is a `db` use, so a suite saturating the read gate holds its slots whether or not the shared test process has a lease context installed.",
  },
] satisfies Exemptions;
