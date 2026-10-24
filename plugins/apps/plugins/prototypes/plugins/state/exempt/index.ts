import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/legacy-trash.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "the old _trash/ adoption moves folders back into the tree; deleted once no branch with the old move-to-trash delete runs",
  },
] satisfies Exemptions;
