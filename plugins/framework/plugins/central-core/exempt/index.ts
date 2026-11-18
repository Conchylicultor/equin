import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "detached-work-safety/no-raw-set-interval",
    paths: ["bin/index.ts"],
    kind: "sanctioned",
    reason:
      "Process entry points' orphan guards: they run before (and outside) the plugin graph that registers timers, and exit the process when its parent dies.",
  },
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).",
  },
  {
    rule: "semaphore/slot-use-site",
    paths: ["bin/lease-scope.ts"],
    kind: "sanctioned",
    reason:
      "Central's entry wires timed-fs's calls as `fs` uses and spawnCaptured's children as `spawn` uses of its live reads' use-scoped slots, as the worktree server's profiler install does.",
  },
] satisfies Exemptions;
