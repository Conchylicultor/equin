import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/define-tabbed-view.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — AvailabilityProbe (calls a hook carried as a value), BadgeProbe (calls a hook carried as a value).",
  },
] satisfies Exemptions;
