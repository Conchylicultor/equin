import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "detached-work-safety/no-raw-set-interval",
    paths: ["server/internal/emitter.ts"],
    kind: "sanctioned",
    reason:
      "A synthetic test harness started by hand from a debug pane, at a rate the person picks (up to 100/s) and stopped after at most a few minutes: not background activity, and its cadence is chosen at runtime.",
  },
] satisfies Exemptions;
