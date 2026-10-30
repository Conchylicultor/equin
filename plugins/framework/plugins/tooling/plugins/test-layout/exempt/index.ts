import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "marker-scan-safety/no-adhoc-marker-scan",
    paths: ["check/index.ts"],
    kind: "sanctioned",
    reason:
      "Token-in-string: asserts vitest.config.ts still contains the literal `include` glob that scopes vitest off bun:test's files. The glob IS a string literal with no enclosing marker call, so a full mask erases the one thing being asserted. Comments must still be masked — the file documents the pair in prose that quotes the same glob, and matching that prose would keep the check passing after the live directive was deleted.",
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
