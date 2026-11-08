import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:no-hardcoded-paths",
    paths: ["check/index.ts", "core/internal/paths.ts"],
    kind: "sanctioned",
    reason: "The check itself and the owner of the path family: paths.ts.",
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
      "core/internal/checkout-minter.ts",
      "core/internal/checkout-owner.ts",
      "core/internal/checkout-ref.ts",
      "core/internal/data-dir.ts",
      "core/internal/data-root-layout.ts",
      "core/internal/data-dirs-manifest.ts",
      "core/internal/paths.ts",
      "core/internal/prune-artifacts.ts",
      "core/internal/toolchain-pin.ts",
      "core/internal/worktree-dirs.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/paths.ts", "core/internal/data-root-layout.ts"],
    kind: "sanctioned",
    reason:
      "The app's fixed dirs under the home dir — the data root (and its legacy name), the local backups dir and Claude Code's own dir and config file — spelled once here: a home-relative path is wherever its segments say, so these are the claims every AppPath under them rests on.",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/checkout-deploys.ts"],
    kind: "sanctioned",
    reason:
      "A namespace's spec.json (written by `./equin build`) names the checkout that published it: a checkout of this repo, which the app runs from.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "core/internal/checkout-ref.ts",
      "core/internal/data-dir.ts",
      "core/internal/paths.ts",
    ],
    kind: "debt",
    task: "task-1793991095-ppkf09",
    reason:
      "A backend loads this module, and its blocking functions do not carry the *Sync name yet: a method bound by an interface others implement, an async function that does sync work inside, or a cascade (data-root resolution) left for the redesign.",
  },
] satisfies Exemptions;
