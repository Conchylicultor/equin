import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/repo-files.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/repo-files.ts"],
    kind: "sanctioned",
    reason:
      "The file-set loaders themselves (loadRepoFiles / loadRepoSnapshot): the one place a listing is taken, by whichever pass root calls them.",
  },
] satisfies Exemptions;
