import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/get-server-commit.ts",
      "server/internal/get-server-graph-hash.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/server-pin.ts"],
    kind: "sanctioned",
    reason:
      "The server pin's `git rev-parse HEAD` runs at module eval, inside the plugin import wave \u2014 before the backend listens, where there is no await to reach for and nothing waits on the thread yet.",
  },
] satisfies Exemptions;
