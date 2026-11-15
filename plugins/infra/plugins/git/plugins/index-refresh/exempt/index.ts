import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/refresh.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["server/internal/refresh.ts"],
    kind: "sanctioned",
    reason:
      "The checkout's own git index, as `git rev-parse --path-format=absolute --git-path index` names it: the app owns it as it owns the checkouts it reads. In a linked worktree it sits in the common `.git/worktrees/<id>/`, outside the checkout root, so `joinAppPath` cannot derive it; the scratch copy beside it is derived from it.",
  },
] satisfies Exemptions;
