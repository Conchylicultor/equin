import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/picker-button.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — PickerButton (unsupported syntax: (BuildHIR::node.lowerReorderableExpression) Expression type `TemplateLiteral` cannot be safely reordered).",
  },
] satisfies Exemptions;
