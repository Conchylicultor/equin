import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:no-hardcoded-paths",
    paths: ["core/internal/declared.ts"],
    kind: "sanctioned",
    reason:
      "The one read of the OS home dir: HOME_DIR, which every path under the home (the data root first) derives from.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/data-root-layout.ts", "core/internal/declared.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "not yet split into server/ + machine/ (moved out of infra/paths' core with the same debt)",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/data-root-layout.ts"],
    kind: "sanctioned",
    reason:
      "The data root under the home dir (and its legacy name), spelled once here: a home-relative path is wherever its segments say, so it is the claim every AppPath under the root rests on.",
  },
] satisfies Exemptions;
