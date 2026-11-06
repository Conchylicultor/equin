import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["machine/internal/owner-sampler.ts"],
    kind: "sanctioned",
    reason:
      "A sampler of the host (every 30 s, beside health-monitor's 10 s host sampler): the per-owner breakdown must be recorded through a contention window, when the job queue it would ride is itself saturated.",
  },
] satisfies Exemptions;
