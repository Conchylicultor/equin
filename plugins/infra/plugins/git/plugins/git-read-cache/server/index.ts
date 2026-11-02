import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { createGitStateMemo } from "./internal/git-state-memo";
export type { GitStateMemo } from "./internal/git-state-memo";
export { createSignedMemo } from "./internal/signed-memo";
export type { SignedMemo } from "./internal/signed-memo";

export default {
  description:
    "Git-state-keyed result memos: skip a gated git recompute when a cheap ungated signature is unchanged; single-flight + coalesce per worktree. createGitStateMemo takes signature/compute per call; createSignedMemo binds them at construction so a resource's revalidate and loader cannot drift.",
} satisfies ServerPluginDefinition;
