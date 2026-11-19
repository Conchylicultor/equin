import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/use-theme-gallery.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — useThemeGallery (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause).",
  },
] satisfies Exemptions;
