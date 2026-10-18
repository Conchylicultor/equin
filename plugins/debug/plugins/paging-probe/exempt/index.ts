import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "detached-work-safety/no-raw-set-interval",
    paths: ["server/internal/probe/entry.ts"],
    kind: "sanctioned",
    reason:
      "Spawned child process measuring its own footprint: importing the plugin runtime would pull the plugin graph into the heap it measures.",
  },
  {
    rule: "sink-safety/no-adhoc-file-sink",
    paths: ["server/internal/probe/entry.ts"],
    kind: "sanctioned",
    reason:
      "The probe is spawned as its own child process under a load-bearing lean-closure constraint (runtime builtins + one zero-import file): importing defineFileSink would pull the plugin graph into the heap whose footprint it measures. Its output is bounded the other way: config-gated off by default, run only for controlled investigations.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/probe-host.ts", "server/internal/probe/entry.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
