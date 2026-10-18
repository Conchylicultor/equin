import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:no-hardcoded-paths",
    paths: [
      "check/index.ts",
      "core/internal/paths.ts",
      "server/internal/bins.ts",
    ],
    kind: "sanctioned",
    reason:
      "The check itself and the owner of the path family: paths.ts, and bins.ts, which resolves the toolchain locations on this machine.",
  },
  {
    rule: "paths:no-inlined-worktree-artifacts",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The paths plugin owns the artifact layout: paths.ts defines it, the prune logic mirrors the filename families, and both have co-located tests naming concrete filenames. This guard stops OTHER plugins re-coupling to the layout.",
  },
  {
    rule: "paths:data-root-not-joined",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The paths plugin owns the root: the single derivation (resolveDataRoot), the registry that joins kind and name onto it, and this check's own patterns.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/checkout-deploys.ts",
      "core/internal/checkout-owner.ts",
      "core/internal/checkout-ref.ts",
      "core/internal/data-dir.ts",
      "core/internal/data-dirs-manifest.ts",
      "core/internal/paths.ts",
      "core/internal/prune-artifacts.ts",
      "core/internal/toolchain-pin.ts",
      "core/internal/worktree-dirs.ts",
      "server/internal/bins.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
