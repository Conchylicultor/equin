import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: [
      "server/internal/process-sampler.ts",
      "server/internal/host-sampler.ts",
    ],
    kind: "sanctioned",
    reason:
      "Samplers of this process / the host every 10 s: the instrument for a wedged backend, below cron's 1-minute floor.",
  },
] satisfies Exemptions;
