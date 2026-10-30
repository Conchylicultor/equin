import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "type-scale:closed-role-ladder:raw-vars",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The type-scale plugin owns the ladder's variables and their declarations.",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/index.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
] satisfies Exemptions;
