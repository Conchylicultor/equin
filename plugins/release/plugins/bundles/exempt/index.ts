import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/claim-pointer.ts",
      "server/internal/out-dir.ts",
      "server/internal/pointer.ts",
      "server/internal/prune.ts",
      "server/internal/resolve-bundle.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
