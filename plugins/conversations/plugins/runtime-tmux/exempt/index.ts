import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["server/internal/tmux-runtime.ts"],
    kind: "sanctioned",
    reason:
      "`tmux load-buffer -b … -` reads the buffer from stdin as a stream.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/claude-session.ts",
      "server/internal/prune-signals-job.ts",
      "server/internal/signals.ts",
      "server/internal/tmux-runtime.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
