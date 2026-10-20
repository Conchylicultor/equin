import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  NotificationsProvider,
  ensureNotificationsClient,
  useResource,
  useResources,
  useResourceAcks,
  hydrateResource,
  hydrateQuery,
  useNotificationsStatus,
  useNotificationsChannelStatuses,
  useNotificationsClient,
  getNotificationsClient,
  useFailingResources,
  useLiveRegistries,
  useLiveSocketKindOf,
} from "./use-resource";
export { hydrateEndpoint } from "./hydrate-endpoint";
export { useEndpointResource } from "./use-endpoint-resource";
export { useQueryResource } from "./use-query-resource";
export type {
  QueryResourceOptions,
  PagedResourceResult,
  ResourcePaging,
} from "./use-query-resource";
export { slowResourceReportSink } from "./slow-resource-reporter";
export type { SlowResourceInfo } from "./slow-resource-reporter";
export {
  pendingMountSnapshot,
  subscribePendingMounts,
} from "./pending-mount-tracker";
export type { PendingMountSnapshot } from "./pending-mount-tracker";
export type { ResourceResult, ResourceTupleResult } from "./use-resource";
export type { ResourceDerivation } from "./notifications-client";
export {
  combineResources,
  useCombinedResources,
  mapResource,
  readyResource,
  refuseResource,
  foldResource,
} from "./resource-utils";
export type {
  GateInput,
  PortableGateInput,
  GateUnavailable,
  GateStatus,
  GateDataOf,
  CombinedResources,
  FoldResourceHandlers,
} from "./resource-utils";
export { ResourceErrorInline } from "./components/resource-error-inline";
export type { ResourceErrorInlineProps } from "./components/resource-error-inline";
export { resourceErrorReportSink } from "./resource-error-reporter";
export type {
  ResourceErrorInfo,
  FailingResource,
} from "./resource-error-reporter";
export { matchResource, ResourceView } from "./components/resource-view";
export type {
  MatchResourceHandlers,
  ResourceViewProps,
} from "./components/resource-view";
export {
  queryKeyFor,
  liveStateSocketKind,
  ResourceStaleReadError,
} from "./notifications-client";
export { httpStaleDropReportSink } from "./stale-drop-reporter";
export { unansweredSubReportSink } from "./unanswered-sub-reporter";
export type { UnansweredSubReport } from "./unanswered-sub-reporter";
export { useResourceContractMismatches } from "./resource-contract-store";
export type { ResourceContractMismatch } from "./resource-contract-store";
export type { HttpStaleDropReport } from "./stale-drop-reporter";
export type {
  ResourceKey,
  ChannelStatuses,
  LiveStateSocketKind,
  DebugSub,
  DebugSnapshot,
  TransportInfo,
  MissedFrame,
} from "./notifications-client";
export { resourceDescriptorByKey, ResourceError } from "../core";
export type {
  ResourceDescriptor,
  ResourceErrorKind,
  ResourceReadiness,
  ResourceStatus,
  ResourceOrigin,
  WindowResourceDescriptor,
  PointResourceDescriptor,
  WindowParams,
  PointParams,
  WindowSelector,
} from "../core";

export default {
  description:
    "Server live-state primitive: useResource hook + NotificationsProvider + NotificationsClient. Thin TanStack Query wrapper over the app's tab-shared /ws/notifications channel. useQueryResource reads a local async load (not a server read — those are live) as a ResourceResult.",
  loadBearing: true,
  contributions: [],
} satisfies PluginDefinition;
