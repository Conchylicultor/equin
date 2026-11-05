import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["machine/internal/phase-git.ts"],
    kind: "sanctioned",
    reason:
      "Classifies ANOTHER checkout's (an agent's worktree's) untracked files for its progress phase; no pass holds that checkout's set.",
  },
] satisfies Exemptions;
