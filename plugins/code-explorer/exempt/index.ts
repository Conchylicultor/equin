import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/checkout-root.ts",
      "server/internal/commit-values.ts",
      "server/internal/contained-path.ts",
      "server/internal/image-handler.ts",
      "server/internal/resolve-worktree-path.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
