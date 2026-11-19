import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/internal/lenses.tsx", "web/internal/move-into.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — lenses.tsx: ResolveLens (calls a hook carried as a value); move-into.ts: useMoveInto (unsupported syntax: Support value blocks (conditional, logical, optional chaining, etc) within a try/catch statement).",
  },
] satisfies Exemptions;
