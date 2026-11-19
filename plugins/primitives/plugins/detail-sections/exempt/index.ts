import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/define-detail-sections.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — DefaultOpenSection (calls a hook carried as a value), AvailableSection (calls a hook carried as a value).",
  },
] satisfies Exemptions;
