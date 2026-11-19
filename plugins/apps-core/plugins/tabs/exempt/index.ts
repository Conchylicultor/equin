import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/use-surface-shown.ts", "web/internal/use-tabs.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — use-surface-shown.ts: useSurfaceShown (calls a hook carried as a value), useSurfaceShowsAppsSideBySide (calls a hook carried as a value); use-tabs.tsx: TabsProvider (unsupported syntax: Handle ??= operators in AssignmentExpression).",
  },
] satisfies Exemptions;
