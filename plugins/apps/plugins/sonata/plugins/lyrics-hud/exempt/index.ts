import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/lyrics-hud.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — LyricsCorner (unsupported syntax: Expected Identifier, got TSAsExpression key in ObjectExpression).",
  },
] satisfies Exemptions;
