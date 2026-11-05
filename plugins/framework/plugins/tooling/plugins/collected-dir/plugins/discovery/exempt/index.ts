import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/discover.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/discover.ts"],
    kind: "debt",
    task: "task-1793856387-73tcw0",
    reason:
      "discoverCollectedDirs lists the checkout itself with one blocking `git ls-files`, for callers that cannot await and hold no set (moved here from codegen's plugin-registry-gen.ts with the same debt).",
  },
] satisfies Exemptions;
