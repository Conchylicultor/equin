import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/session.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — PlaybackSession (unsupported syntax: (BuildHIR::node.lowerReorderableExpression) Expression type `CallExpression` cannot be safely reordered).",
  },
] satisfies Exemptions;
