import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/config-watcher.ts",
      "server/internal/fork.ts",
      "server/internal/jsonc-proxy.ts",
      "server/internal/orphan-audit.ts",
      "server/internal/registry.ts",
      "server/internal/resource.ts",
      "server/internal/scope-fork.ts",
      "server/internal/scope-paths.ts",
      "server/internal/scope-snapshot.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
