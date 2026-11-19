import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/background-music-root.tsx",
      "web/components/music-panel.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — background-music-root.tsx: SourcePlayer (calls a hook carried as a value), LabelProbe (passes a hook around as a value); music-panel.tsx: SourceRow (passes a hook around as a value), AvailableSourceRow (calls a hook carried as a value).",
  },
] satisfies Exemptions;
