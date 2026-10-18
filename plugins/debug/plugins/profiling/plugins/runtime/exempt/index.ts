import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sink-safety/no-adhoc-profiler-seam",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "Serves the live flight window on demand to the Debug \u2192 Profiling Gantt pane; getRuntimeProfile has no in-flight set to supply it.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/mcp-tools.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
