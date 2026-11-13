import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "shared/batch-processes.ts",
      "shared/batch-worker.ts",
      "shared/full-check.ts",
      "shared/keys.ts",
      "shared/launch.ts",
      "shared/name-check.ts",
      "shared/name-host.ts",
      "shared/name-records.ts",
      "shared/name-resolve.ts",
      "shared/name-run.ts",
      "shared/name-store.ts",
      "shared/name-walk.ts",
      "shared/pass-set.ts",
      "shared/repo-view.ts",
      "shared/tsc-engine.ts",
      "shared/worker.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["shared/batch-worker.ts"],
    kind: "sanctioned",
    reason:
      "the job file the spawning worker wrote in its spool, passed by argv to this batch process",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "shared/batch-processes.ts",
      "shared/batch-worker.ts",
      "shared/name-store.ts",
      "shared/pass-set.ts",
      "shared/repo-view.ts",
      "shared/tsc-engine.ts",
      "shared/worker.ts",
    ],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;
