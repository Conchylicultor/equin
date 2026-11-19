import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/health-row.tsx",
      "web/components/status-probes.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — health-row.tsx: InfoRowView (calls a hook carried as a value); status-probes.tsx: StatusProbe (calls a hook carried as a value).",
  },
] satisfies Exemptions;
