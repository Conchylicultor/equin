import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/prompt-form.tsx",
      "web/components/screenshot-button.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — prompt-form.tsx: PromptForm (unsupported syntax: Support value blocks (conditional, logical, optional chaining, etc) within a try/catch statement); screenshot-button.tsx: ScreenshotButton (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause).",
  },
] satisfies Exemptions;
