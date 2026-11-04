import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/record-fs-waits.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "not yet split into server/ + machine/ — a machine/ barrel would fit (it writes the computer's disk), but the CLI entry (framework/cli bin/) that also calls it may not import a machine barrel",
  },
] satisfies Exemptions;
