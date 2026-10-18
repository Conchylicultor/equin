import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/paths.ts",
      "server/internal/picks.ts",
      "server/internal/signature.ts",
      "server/internal/status.ts",
      "server/internal/tree-path.ts",
      "shared/folder-signature.ts",
      "shared/history/lock.ts",
      "shared/history/store.ts",
      "shared/list-metas.ts",
      "shared/mint.ts",
      "shared/read-folder.ts",
      "shared/record-store.ts",
      "shared/template.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
