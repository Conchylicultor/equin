import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "repo-walk-safety/no-adhoc-repo-walk",
    paths: ["core/scripts/fix-shared-to-relative.ts"],
    kind: "sanctioned",
    reason:
      "A one-off migration script that already ran. It walks the way every check did before they moved to `listRepoFiles`; nothing runs it, so its file set decides no verdict.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/cache.ts",
      "core/content-hash.ts",
      "core/discover.ts",
      "core/grep-code.ts",
      "core/progress-log.ts",
      "core/read-set.ts",
      "core/scan-context.ts",
      "core/thread-attribution.ts",
      "core/thrown-outcome.ts",
      "core/transcript.ts",
      "core/tree-hash.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
