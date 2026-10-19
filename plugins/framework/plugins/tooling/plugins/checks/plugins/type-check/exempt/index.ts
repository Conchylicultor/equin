import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/spawn-worker.ts",
      "shared/contract-refs.ts",
      "shared/keyed-check.ts",
      "shared/lockfile.ts",
      "shared/pass-set.ts",
      "shared/program-graph.ts",
      "shared/program-manifest.ts",
      "shared/type-fingerprint.ts",
      "shared/worker.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
