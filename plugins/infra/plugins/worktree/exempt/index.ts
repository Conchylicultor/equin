import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "worktree/no-raw-worktree-git",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The worktree plugin is the crash-safe replacement for the worktree-enumerating git commands: its claim's switch builds its argv in steps (adding --ignore-other-worktrees only after its own checked-out-elsewhere check), and it is where any future raw call belongs.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/composition-namespace.ts",
      "server/internal/dep-store-pool.ts",
      "server/internal/install-checkout.ts",
      "server/internal/spare-name.ts",
      "server/internal/spare.ts",
      "server/internal/spec.ts",
      "server/internal/worktree-op.ts",
      "server/internal/worktree-op-marker.ts",
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
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/worktree-op-marker.ts"],
    kind: "sanctioned",
    reason:
      "The op marker's writer, called only by the op's own CLI process (./equin build / push / a direct op, and the op-status synthetic script) — never by a backend — and its release() runs in that process's process.on(\"exit\") handler, which cannot await. The readers a backend calls (worktree-op.ts) are async.",
  },
] satisfies Exemptions;
