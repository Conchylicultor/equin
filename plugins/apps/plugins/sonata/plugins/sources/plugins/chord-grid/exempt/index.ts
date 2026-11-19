import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/chord-grid-editor-section.tsx", "web/loader.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — chord-grid-editor-section.tsx: ChordGridEditorSection (passes a hook around as a value); loader.tsx: ChordGridLoader (passes a hook around as a value).",
  },
] satisfies Exemptions;
