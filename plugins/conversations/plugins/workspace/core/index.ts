export {
  WorkspaceKindSchema,
  WorkspaceCapabilitySchema,
  WorkspaceSpecSchema,
  WORKSPACE_KINDS,
  WORKSPACE_CAPABILITIES,
  DEFAULT_WORKSPACE,
  hasCapability,
  assertCapability,
  satisfiesCapabilities,
  workspaceAllows,
} from "./workspace";
export type {
  WorkspaceKind,
  WorkspaceCapability,
  WorkspaceSpec,
  WorkspaceKindState,
} from "./workspace";
export { WorkspaceChoiceSchema, workspaceCatalog } from "./catalog";
export type { WorkspaceChoice } from "./catalog";
