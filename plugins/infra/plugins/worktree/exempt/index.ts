import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/composition-namespace.ts",
      "server/internal/install-checkout.ts",
      "server/internal/spare-name.ts",
      "server/internal/spare.ts",
      "server/internal/spec.ts",
      "server/internal/worktree-op.ts",
      "server/internal/worktree.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["server/internal/worktree.ts"],
    kind: "sanctioned",
    reason:
      "The main worktree — git's first `worktree list` entry, the checkout the app runs from (ensureMainWorktreeRoot). Every other listed path stays a plain string: git lists worktrees wherever their owner put them.",
  },
] satisfies Exemptions;
