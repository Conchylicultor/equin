import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/spawn-worker.ts",
      "shared/full-check.ts",
      "shared/keys.ts",
      "shared/lockfile.ts",
      "shared/name-check.ts",
      "shared/name-host.ts",
      "shared/name-records.ts",
      "shared/name-resolve.ts",
      "shared/name-run.ts",
      "shared/name-store.ts",
      "shared/name-walk.ts",
      "shared/pass-set.ts",
      "shared/tsc-engine.ts",
      "shared/worker.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
