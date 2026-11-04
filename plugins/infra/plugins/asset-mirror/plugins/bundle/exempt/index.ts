import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/fetch-to-disk.ts",
      "server/internal/run-prewarm.ts",
      "server/internal/seed-cache.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "moved out of the asset mirror's portable server/ with the release-bundle machinery; its consumers (the release CLI, the launcher's server) are host processes — not yet split into server/ + machine/",
  },
] satisfies Exemptions;
