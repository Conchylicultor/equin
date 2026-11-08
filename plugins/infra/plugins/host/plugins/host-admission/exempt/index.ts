import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "host-pools-declared",
    paths: ["server"],
    kind: "sanctioned",
    reason:
      "The registry: the one legitimate owner of createHostSemaphore, through which every host pool is declared (defineHostPool).",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/budget.ts", "server/internal/pool.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
