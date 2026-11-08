import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/tree-lock.ts"],
    kind: "sanctioned",
    reason:
      "A linked worktree's git dir is the path its own `.git` file names (`gitdir:`) — git's admin dir for a checkout the app owns, under the main checkout's `.git/worktrees/`.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/tree-lock.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: ["core/internal/tree-lock.ts"],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;
