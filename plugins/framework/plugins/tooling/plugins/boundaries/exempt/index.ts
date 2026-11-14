import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/check.ts", "core/resolve.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: ["core/check.ts"],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
  {
    rule: "source-read-safety/no-text-source-read",
    paths: [
      "check/machine-portable-declaration.ts",
      "check/portable-own-barrels.scan.ts",
    ],
    kind: "debt",
    task: "task-1794623832-1sr8c7",
    reason:
      "Written before sourceAnalysis(ctx): reads code through parse-utils' text helpers (regexes over masked source), which skip what they cannot guess.",
  },
] satisfies Exemptions;
