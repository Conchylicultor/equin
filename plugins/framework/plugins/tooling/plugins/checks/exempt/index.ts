import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "imperative-create-table-allowlisted",
    paths: ["cli/internal/grep-index-store.ts"],
    kind: "sanctioned",
    reason:
      "The grep index is a SQLite file under the data root (bun:sqlite), not a table of the app's Postgres database: the allowlist and the orphaned-db-tables check it feeds are about Postgres schema.",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-walk",
    paths: ["core/scripts/fix-shared-to-relative.ts"],
    kind: "sanctioned",
    reason:
      "A one-off migration script that already ran. It walks the way every check did before they moved to `listRepoFiles`; nothing runs it, so its file set decides no verdict.",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/tree-hash.ts"],
    kind: "sanctioned",
    reason:
      "The checkout's own git index, as `git rev-parse --path-format=absolute --git-path index` names it: the app owns it as it owns the checkout. In a linked worktree it sits in the common `.git/worktrees/<id>/`, outside the checkout root, so `joinAppPath` cannot derive it; every scratch path beside it is derived from it.",
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
      "core/whole-tree-read.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/repo-set.ts"],
    kind: "sanctioned",
    reason:
      "The check runner's own `ctx.repo()`: read off the run's tree snapshot, and listed only when there is none (`--no-cache`, or a snapshot that failed to load) \u2014 once per run, shared by every check.",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/repo-files.ts"],
    kind: "sanctioned",
    reason:
      "`listRepoFiles`, the array form of `loadRepoFiles` for a pass root and test fixtures; a check reads `ctx.repo()`.",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["core/tree-hash.ts"],
    kind: "sanctioned",
    reason:
      "Lists a SCRATCH index (`read-tree` of the run's tree, then `ls-files -s` over it): git's own answer to which files a pathspec names in the run's tree \u2014 no working-tree read.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "core/cache.ts",
      "core/content-hash.ts",
      "core/progress-log.ts",
      "core/scripts/fix-shared-to-relative.ts",
      "core/thread-attribution.ts",
      "core/transcript.ts",
      "core/tree-hash.ts",
    ],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;
