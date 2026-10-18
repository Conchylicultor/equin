import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/claudemd-conflicts.ts",
      "core/internal/git-dir.ts",
      "core/internal/merge-markers.ts",
      "core/internal/registry-entry.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
