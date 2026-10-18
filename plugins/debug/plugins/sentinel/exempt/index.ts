import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "detached-work-safety/no-raw-set-interval",
    paths: ["server/internal/worker/entry.ts"],
    kind: "sanctioned",
    reason:
      "Bun Worker thread (the sentinel's sampler / duress latch). A worker has no plugin runtime, no registry and no profiler; it must keep sampling while the main loop is wedged — the thing it exists to detect.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/status-resource.ts",
      "server/internal/worker-host.ts",
      "server/internal/worker/pg.ts",
      "server/internal/worker/sample.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
