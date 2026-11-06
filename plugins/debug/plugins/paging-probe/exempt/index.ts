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
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/probe/entry.ts"],
    kind: "sanctioned",
    reason:
      "Spawned child process (never the backend): its appendFileSync stalls only the probe, and the sync write is deliberate — it measures paging stalls on its own thread.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/probe-host.ts", "server/internal/probe/entry.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["server/internal/probe/entry.ts"],
    kind: "sanctioned",
    reason:
      "The probe child's --out argv is the logs-dir path its own supervisor (probe-host.ts) built from the worktree data dir; the child cannot import the paths module without growing the heap it measures.",
  },
] satisfies Exemptions;
