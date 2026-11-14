import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/index.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
  {
    rule: "source-read-safety/no-text-source-read",
    paths: ["check/mask.ts"],
    kind: "debt",
    task: "task-1794623832-1sr8c7",
    reason:
      "Written before sourceAnalysis(ctx): reads code through parse-utils' text helpers (regexes over masked source), which skip what they cannot guess.",
  },
] satisfies Exemptions;
