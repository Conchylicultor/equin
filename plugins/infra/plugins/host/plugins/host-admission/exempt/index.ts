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
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/pool.ts"],
    kind: "debt",
    task: "task-1794166603-5gddnj",
    reason:
      "The gate gauge's host-wide occupancy probe (probeOccupancySync) opens every slot file synchronously: registerGateGauge's reader is a sync () => GateGauge (runtime-profiler), read on every gauge snapshot and slow-wait notification. Every other probe (hostOccupancy) is async; this one goes once the gauge reader may be async.",
  },
] satisfies Exemptions;
