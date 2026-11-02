import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "web/internal/build-measurer-page.ts",
      "web/internal/build-page.ts",
      "web/internal/measure-page.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "boundaries:web-loads-portable",
    paths: [
      "web/internal/build-measurer-page.ts",
      "web/internal/measure-page.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "The geometry suite's Node driver (Vite build in a child, Playwright) sits in web/ beside the measurer page it drives; it never runs in a browser realm. Moves out of web/ with the server/ + machine/ split.",
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
