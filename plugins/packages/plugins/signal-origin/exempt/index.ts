import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/signal-origin.fixture.ts",
      "server/internal/signal-origin.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["server/internal/signal-origin.fixture.ts"],
    kind: "sanctioned",
    reason: "A test fixture process; its --out dir is the test's own temp dir.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/signal-origin.fixture.ts"],
    kind: "sanctioned",
    reason:
      "A child process the test spawns, never a backend: its sync writes (some inside a signal handler, which must land before the process dies) stall only itself.",
  },
] satisfies Exemptions;
