import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "marker-scan-safety/no-adhoc-marker-scan",
    paths: ["check/parse.ts"],
    kind: "sanctioned",
    reason:
      "Dual-mask: statement structure (brace/semicolon depth) is detected on a FULL mask; only the final statement text is sliced from the strings-kept copy at identical offsets so downstream sees real module specifiers.",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/parse.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
  {
    rule: "import-scan-safety/no-hand-import-resolution",
    paths: ["check/test-only-exports.ts"],
    kind: "debt",
    task: "task-1794573514-c7sfqg",
    reason:
      "Resolves an `@plugins/\u2026` import specifier to a repo file by hand, beside the plugin-records module graph; to read resolved imports off the graph instead.",
  },
] satisfies Exemptions;
