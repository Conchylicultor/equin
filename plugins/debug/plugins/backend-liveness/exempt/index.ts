import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["central/internal/probe.ts"],
    kind: "sanctioned",
    reason:
      "Central has no job queue, and the probe must tick below cron's 1-minute floor: it is the outside observer that notices a backend whose JS thread stopped, so it cannot run inside any backend.",
  },
] satisfies Exemptions;
