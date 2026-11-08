import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/install.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "timed-fs/no-untimed-fs-read",
    paths: ["scripts/fs-meter-bench.ts"],
    kind: "sanctioned",
    reason:
      "the benchmark's baseline: what an untimed node:fs call costs, against the timed one under each meter",
  },
] satisfies Exemptions;
