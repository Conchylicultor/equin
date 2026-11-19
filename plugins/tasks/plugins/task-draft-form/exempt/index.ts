import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/task-draft-popover.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — TaskDraftFormContent (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause).",
  },
] satisfies Exemptions;
