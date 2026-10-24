import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The repo-tree half of `./equin build`'s codegen, standalone. `push`
 * needs it after a rebase — the merge driver may have auto-resolved a generated
 * file to a side that no longer matches the merged sources — and paying for a
 * whole build there would mean a build lock, a Postgres wait and a DB fork for
 * a pass that only rewrites files in the tree.
 */
export default defineCliCommand({
  name: "regen-generated",
  description:
    "Regenerate all non-migration repo-tree codegen artifacts: barrel stubs, " +
    "plugin registries, plugin docs (compact/details/CLAUDE.md autogen blocks), " +
    "the reorderable-slots / data-views / token-group-vars manifests, and config " +
    "origins. This is the SAME ordered repo-tree pipeline `./equin build` " +
    "runs (shared via codegen core), so a full build immediately after is a no-op. " +
    "Used by the post-rebase normalize step in `push`. Idempotent.",
  run: () => import("./run"),
});
