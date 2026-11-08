import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/bin.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/bin.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "pgClientBin hands existsSync to the resolver as its probe: a one-time, memoized stat per tool, still on the backend's thread the first time a fork or backup asks.",
  },
] satisfies Exemptions;
