import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "scroll-safety/no-adhoc-scroll-write",
    paths: ["web"],
    kind: "sanctioned",
    reason:
      "The auto-scroll primitive is the one sanctioned home for raw scroll writes — its whole web/ folder, so a new scroll role added there is covered.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/use-edge-auto-scroll.ts", "web/use-sticky-scroll.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — use-edge-auto-scroll.ts: useEdgeAutoScroll (unsupported syntax: Handle ??= operators in AssignmentExpression); use-sticky-scroll.ts: useStickyScroll (its hand-written memoization cannot be preserved).",
  },
] satisfies Exemptions;
