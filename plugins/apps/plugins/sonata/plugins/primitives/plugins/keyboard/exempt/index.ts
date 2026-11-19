import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/keyboard.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — Keyboard (unsupported syntax: (BuildHIR::node.lowerReorderableExpression) Expression type `ArrowFunctionExpression` cannot be safely reordered).",
  },
] satisfies Exemptions;
