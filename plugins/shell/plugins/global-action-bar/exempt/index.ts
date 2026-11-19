import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "The equin shell's solo-mode chrome (the floating global action bar). The standalone website draws its own layout, and the live demo's embedded app carries its own header — the page does without it.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/use-bar-activities.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — ActivityProbe (calls a hook carried as a value).",
  },
] satisfies Exemptions;
