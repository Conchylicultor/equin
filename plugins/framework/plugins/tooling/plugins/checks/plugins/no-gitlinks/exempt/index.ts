import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["check/index.ts"],
    kind: "sanctioned",
    reason:
      "`ls-files --stage` reads the index's modes (an index-only read, no working-tree stat): a tracked gitlink whose directory is gone is in no file set or tree, only in the index. And only when the run could not hash the working tree, `ls-files --others` names the commit-less nested repository that broke `git add -A`.",
  },
] satisfies Exemptions;
