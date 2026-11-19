import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/floating-foreground.tsx",
      "web/components/floating-tabs-bridge.tsx",
      "web/components/window-snapshot.tsx",
      "web/floating-placement.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — floating-foreground.tsx: FloatingForeground (an eslint-disable of a react-hooks rule in it makes the compiler skip it); floating-tabs-bridge.tsx: FloatingTabsBridge (an eslint-disable of a react-hooks rule in it makes the compiler skip it); window-snapshot.tsx: WindowSnapshot (an eslint-disable of a react-hooks rule in it makes the compiler skip it); floating-placement.tsx: FloatingChrome (calls a hook carried as a value).",
  },
] satisfies Exemptions;
