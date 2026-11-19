import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/agent-thread.tsx", "web/internal/use-thread.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — agent-thread.tsx: LiveThread (an eslint-disable of a react-hooks rule in it makes the compiler skip it); use-thread.ts: useStableResults (an eslint-disable of a react-hooks rule in it makes the compiler skip it).",
  },
] satisfies Exemptions;
