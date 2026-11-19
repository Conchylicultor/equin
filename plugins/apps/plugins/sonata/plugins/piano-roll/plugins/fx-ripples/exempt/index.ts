import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/fx-ripples.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — SoundWaveRipplesFx (unsupported syntax: Handle UpdateExpression to variables captured within lambdas).",
  },
] satisfies Exemptions;
