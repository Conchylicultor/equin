import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/seed-cache.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "moved out of the asset mirror's portable server/ with the release-bundle machinery; its consumers (the release CLI, the launcher's server) are host processes — not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/seed-cache.ts"],
    kind: "sanctioned",
    reason:
      "runs once in the release launcher process (bin/launch.ts), before bootSelfContainedApp spawns the gateway and the backend — no backend's thread waits on it",
  },
] satisfies Exemptions;
