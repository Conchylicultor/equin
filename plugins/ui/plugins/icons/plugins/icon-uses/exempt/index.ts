import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "import-scan-safety/no-hand-import-resolution",
    paths: ["core/icon-module.ts"],
    kind: "debt",
    task: "task-1794573514-c7sfqg",
    reason:
      "Resolves an `@plugins/\u2026` import specifier to a repo file by hand, beside the plugin-records module graph; to read resolved imports off the graph instead.",
  },
] satisfies Exemptions;
