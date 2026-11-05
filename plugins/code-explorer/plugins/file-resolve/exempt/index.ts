import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["machine/internal/resolve-path.ts"],
    kind: "sanctioned",
    reason:
      "Resolves a path in ANOTHER checkout (an agent's worktree) for a live read; no pass holds that checkout's set.",
  },
] satisfies Exemptions;
