import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { workspaceCatalogServed } from "./internal/catalog";

export { Workspace } from "./internal/registry";
export type {
  LaunchContext,
  LaunchFragment,
  LaunchPermissions,
  LaunchMcpServer,
  Resumability,
  SettingSource,
  WorkspaceAt,
  WorkspaceImpl,
  WorkspacePrepareCtx,
} from "./internal/registry";
export {
  ScratchProfile,
  defineScratchProfile,
} from "./internal/scratch-profile";
export type { ScratchProfileDef } from "./internal/scratch-profile";
export { parseWorkspaceSpec } from "./internal/parse-spec";
export {
  findWorkspaceOfConversation,
  workspaceOfConversation,
} from "./internal/workspace-of";
export {
  WorkspaceReclaimed,
  announceWorkspacesReclaimed,
} from "./internal/reclaimed";
export type { WorkspaceReclaimedHandler } from "./internal/reclaimed";

export default {
  description:
    "Agent workspaces — where a conversation runs (a git worktree, or a scratch directory): the WorkspaceImpl contract and the per-kind registry the conversation lifecycle calls through (path, commit, prepare, finish, launch fragment, resumability), the scratch-profile registry feature plugins contribute to and parseWorkspaceSpec over it (a new attempt's spec, validated before any write), the workspace.catalog live value (every workspace a task can name), the conversation → workspace lookup, and the Workspace.Reclaimed announcement (every reaper calls announceWorkspacesReclaimed once it deleted attempts' workspaces; every plugin keeping per-attempt state contributes a handler that frees it).",
  contributions: [...workspaceCatalogServed.declare],
} satisfies ServerPluginDefinition;
