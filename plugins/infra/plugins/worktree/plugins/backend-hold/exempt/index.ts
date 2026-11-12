import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints:no-raw-json-handlers",
    paths: ["server/internal/hold.test.ts"],
    kind: "sanctioned",
    reason:
      "A stubbed fetch standing in for the Go gateway's stop/restart answers, not an endpoint handler: there is no implement() on the other side to return a plain object from.",
  },
] satisfies Exemptions;
