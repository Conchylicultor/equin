import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/table-block.tsx",
      "web/components/table-chrome.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — table-block.tsx: TableBlock (unsupported syntax: (BuildHIR::node.lowerReorderableExpression) Expression type `ArrowFunctionExpression` cannot be safely reordered); table-chrome.tsx: TableChrome (unsupported syntax: Expected Identifier, got ConditionalExpression key in ObjectExpression).",
  },
] satisfies Exemptions;
