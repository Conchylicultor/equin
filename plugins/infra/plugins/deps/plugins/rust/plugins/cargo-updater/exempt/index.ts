import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/cargo-updater.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["server/internal/cargo-updater.ts"],
    kind: "sanctioned",
    reason:
      "Finds the rust/ crates (pathspec-scoped) for an upgrade op, which holds no file set.",
  },
] satisfies Exemptions;
