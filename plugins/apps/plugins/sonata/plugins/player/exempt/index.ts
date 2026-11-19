import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/view.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — PlayerDisplayBinding (its hand-written memoization cannot be preserved), PlayerViewProvider (its hand-written memoization cannot be preserved).",
  },
] satisfies Exemptions;
