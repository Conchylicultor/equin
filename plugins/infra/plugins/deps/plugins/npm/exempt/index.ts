import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/npm-updater.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "repo-walk-safety/no-adhoc-repo-listing",
    paths: ["server/internal/npm-updater.ts"],
    kind: "sanctioned",
    reason:
      "The npm updater rewrites manifests and reinstalls between its reads of the workspace, so each read lists afresh; it runs in an upgrade op, never in a check pass.",
  },
] satisfies Exemptions;
