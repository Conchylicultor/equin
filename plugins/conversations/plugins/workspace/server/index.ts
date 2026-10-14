import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { Workspace } from "./internal/registry";
export type {
  LaunchContext,
  LaunchFragment,
  Resumability,
  WorkspaceAt,
  WorkspaceImpl,
} from "./internal/registry";
export {
  ScratchProfile,
  defineScratchProfile,
} from "./internal/scratch-profile";
export type { ScratchProfileDef } from "./internal/scratch-profile";
export {
  findWorkspaceOfConversation,
  workspaceOfAttempt,
  workspaceOfConversation,
} from "./internal/workspace-of";

export default {
  description:
    "Agent workspaces — where a conversation runs (a git worktree, or a scratch directory): the WorkspaceImpl contract and the per-kind registry the conversation lifecycle calls through (path, commit, prepare, finish, launch fragment, resumability), the scratch-profile registry feature plugins contribute to, and the conversation → workspace lookup.",
} satisfies ServerPluginDefinition;
