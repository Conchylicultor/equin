import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/launcher-overlay.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — LauncherOverlay (unsupported syntax: Handle UpdateExpression to variables captured within lambdas).",
  },
] satisfies Exemptions;
