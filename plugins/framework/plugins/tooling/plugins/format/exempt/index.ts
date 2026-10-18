import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "format-safety/no-adhoc-prettier",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The single sanctioned chokepoint for prettier: tooling/format IS the memoized dynamic import and the hardcoded options object.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/changed-files.ts",
      "core/internal/format-sources.ts",
      "core/internal/format-thread.ts",
      "core/internal/format-worker.ts",
      "core/internal/prettier.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
