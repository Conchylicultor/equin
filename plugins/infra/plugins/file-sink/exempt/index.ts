import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sink-safety/no-adhoc-file-sink",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The sanctioned append chokepoint: file-sink IS the implementation of bounded, rotated, declared durable append.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/file-sink.ts",
      "core/internal/history.ts",
      "core/internal/read.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
