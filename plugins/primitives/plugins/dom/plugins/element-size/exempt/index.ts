import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "resize-observer-safety/no-raw-resize-observer",
    paths: ["web/internal/element-size.ts"],
    kind: "sanctioned",
    reason:
      "The element-size primitive is the one sanctioned home for the idiom.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/element-size.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — useResizeObserver (an eslint-disable of a react-hooks rule in it makes the compiler skip it), useResizeObserverSet (unsupported syntax: Handle ??= operators in AssignmentExpression).",
  },
] satisfies Exemptions;
