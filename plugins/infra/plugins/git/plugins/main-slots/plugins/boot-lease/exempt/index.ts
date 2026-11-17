import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/hold-sync.ts", "core/internal/drain-sync.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/hold-sync.ts"],
    kind: "sanctioned",
    reason:
      "checkoutRootOfSync walks up from a module's own path to the checkout holding it — the checkout the app runs from, which the app owns.",
  },
  {
    rule: "user-path/no-sync-fs",
    paths: ["core/internal/hold-sync.ts", "core/internal/drain-sync.ts"],
    kind: "sanctioned",
    reason:
      "Run at a process's entry, before it loads code (the CLI bootstrap, the agent host's boot), or as it lets its slot go (an explicit release, an exit handler), on the checkout the process runs from — never a backend's thread while it serves, never a path the user chose.",
  },
] satisfies Exemptions;
