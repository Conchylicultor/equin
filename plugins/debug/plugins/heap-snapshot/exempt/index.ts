import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/handle-capture-snapshot.ts",
      "server/internal/heap-stats.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "process-memory/no-rss-memory",
    paths: ["server/internal/heap-stats.ts"],
    kind: "sanctioned",
    reason:
      "the off-macOS fallback: a host with no physical footprint (procMemory() null) has only the resident size to show, and the footprint is read first wherever one exists.",
  },
] satisfies Exemptions;
