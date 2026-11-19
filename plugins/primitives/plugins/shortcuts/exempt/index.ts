import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "shortcuts/no-window-key-listener",
    paths: ["web/internal/shortcut-manager.tsx"],
    kind: "sanctioned",
    reason:
      "The registry's own dispatcher is the one sanctioned page-wide listener.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/use-registered-shortcuts.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — useRegisteredShortcuts (an eslint-disable of a react-hooks rule in it makes the compiler skip it).",
  },
] satisfies Exemptions;
