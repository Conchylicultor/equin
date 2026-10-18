import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The single sanctioned chokepoint for async child processes: infra/spawn IS the implementation of wedge-proof (fd-redirected) spawning, its daemon child (long-lived supervised children) included.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/git-roots.ts",
      "core/internal/spawn-captured.ts",
      "core/internal/spawn-passthrough.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
