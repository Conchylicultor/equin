import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/import-status-files.ts",
      "server/internal/legacy-trash.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "the one-time _status import reads the retired files, and the old _trash/ adoption moves folders back; both deleted with the import (follow-up task)",
  },
] satisfies Exemptions;
