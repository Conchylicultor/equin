import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/apple-setup.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — AppleSetup (unsupported syntax: Handle TryStatement without a catch clause).",
  },
] satisfies Exemptions;
