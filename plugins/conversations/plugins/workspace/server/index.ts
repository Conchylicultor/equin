import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { workspaceCatalogServed } from "./internal/catalog";

export { Workspace } from "./internal/registry";
export type {
  LaunchContext,
  LaunchFragment,
  LaunchMcpServer,
  Resumability,
  SettingSource,
  WorkspaceAt,
  WorkspaceImpl,
} from "./internal/registry";
export {
  ScratchProfile,
  defineScratchProfile,
} from "./internal/scratch-profile";
export type { ScratchProfileDef } from "./internal/scratch-profile";
export { parseWorkspaceSpec } from "./internal/parse-spec";
export {
  findWorkspaceOfConversation,
  workspaceOfAttempt,
  workspaceOfConversation,
} from "./internal/workspace-of";

export default {
  portable: true,
  description:
    "Agent workspaces — where a conversation runs (a git worktree, or a scratch directory): the WorkspaceImpl contract and the per-kind registry the conversation lifecycle calls through (path, commit, prepare, finish, launch fragment, resumability), the scratch-profile registry feature plugins contribute to and parseWorkspaceSpec over it (a new attempt's spec, validated before any write), the workspace.catalog live value (every workspace a task can name), and the conversation → workspace lookup.",
  contributions: [...workspaceCatalogServed.declare],
} satisfies ServerPluginDefinition;
