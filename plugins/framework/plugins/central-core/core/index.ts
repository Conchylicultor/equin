export { centralCollectedDir } from "./collected-dir";
export {
  defineResource,
  defineExternalResource,
  handleResourceHttp,
  notificationsWsHandler,
  setCentralBuildIdentity,
} from "./resources";
export type {
  DependsOnEntry,
  Resource,
  ExternalResource,
  ResourceDefinition,
  ResourceMode,
  ResourceParams,
} from "./resources";
export type {
  CentralPluginDefinition,
  LoadedCentralPlugin,
  HttpHandler,
  Registration,
  ResourceLike,
  WsData,
  WsHandler,
} from "./types";
