import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/archive/locate.ts",
      "server/internal/archive/tree.ts",
      "server/internal/complete.ts",
      "server/internal/entry.ts",
      "server/internal/extract.ts",
      "server/internal/free-path.ts",
      "server/internal/list.ts",
      "server/internal/move.ts",
      "server/internal/open-file.ts",
      "server/internal/open.ts",
      "server/internal/path.ts",
      "server/internal/peek.ts",
      "server/internal/raw.ts",
      "server/internal/stat.ts",
      "server/internal/text.ts",
      "server/internal/volume.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
