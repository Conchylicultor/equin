import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "pane/no-core-define-route-in-web",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The plugin does not address itself through the cross-plugin specifier: its web/ files reach ../core relatively, and its jsdom suites drive the core barrel directly on purpose.",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/identity-manifest.ts", "check/index.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
] satisfies Exemptions;
