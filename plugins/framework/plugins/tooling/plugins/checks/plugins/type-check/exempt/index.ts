import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/spawn-worker.ts",
      "shared/batch-processes.ts",
      "shared/batch-worker.ts",
      "shared/full-check.ts",
      "shared/keys.ts",
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
    paths: ["shared/worker.ts", "shared/batch-worker.ts"],
    kind: "sanctioned",
    reason:
      "the job file the spawning type-check wrote, passed by argv to this worker process",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/import-graph.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
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
