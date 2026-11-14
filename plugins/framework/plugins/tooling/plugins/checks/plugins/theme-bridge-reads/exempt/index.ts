import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "source-read-safety/no-text-source-read",
    paths: ["check/theme-bridge-reads.scan.ts"],
    kind: "debt",
    task: "task-1794623832-1sr8c7",
    reason:
      "Written before sourceAnalysis(ctx): reads code through parse-utils' text helpers (regexes over masked source), which skip what they cannot guess.",
  },
] satisfies Exemptions;
