import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/launch.ts",
      "server/internal/profile-input.ts",
      "server/internal/profile.ts",
      "server/internal/submit.ts",
      "server/internal/workspace-file.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
