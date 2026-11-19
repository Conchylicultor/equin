import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/piano-roll.tsx", "web/internal/pixi/app.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — piano-roll.tsx: PianoRollInner (reads a ref during render); app.tsx: PianoRollCanvas (an eslint-disable of a react-hooks rule in it makes the compiler skip it).",
  },
] satisfies Exemptions;
