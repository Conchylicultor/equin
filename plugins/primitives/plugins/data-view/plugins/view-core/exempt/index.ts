import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/internal/use-view-model.ts",
      "web/internal/use-views-config.ts",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — use-view-model.ts: useViewModel (unsupported syntax: Unexpected terminal kind `ternary` for logical test block); use-views-config.ts: useViewsConfig (its hand-written memoization cannot be preserved).",
  },
] satisfies Exemptions;
