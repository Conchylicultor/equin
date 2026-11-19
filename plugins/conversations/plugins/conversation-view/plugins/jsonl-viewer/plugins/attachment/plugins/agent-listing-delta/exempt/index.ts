import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/agent-listing-delta-view.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — AgentListingDeltaView (unsupported syntax: Unexpected terminal kind `ternary` for logical test block).",
  },
] satisfies Exemptions;
