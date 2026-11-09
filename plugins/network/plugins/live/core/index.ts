export { liveCollection } from "./internal/live-collection";
export type {
  CollectionRow,
  NotCollectionRow,
} from "./internal/collection-row";
// Whether a point id set can carry an id (non-empty, comma-free) — what
// `useLive(c, { id })` answers `found: false` for instead of encoding.
export { isPointId } from "./internal/window-descriptor";
export { LIVE_WEB_HOOKS } from "./internal/read-hooks";
export type { LiveColumnRef, LiveColumnRefOwner } from "./internal/column-ref";
export {
  liveArm,
  LIVE_COLUMNS_KEY,
  LIVE_SCOPED_KEY,
  scopedLiveColumns,
} from "./internal/live-columns";
export type {
  ContributedColumns,
  LiveArm,
  LiveArmColumnsHandle,
  LiveColumnsDeclaration,
  LiveColumnsOwner,
  LiveScopedColumns,
  ScopedColumnMember,
  WithContributedColumns,
} from "./internal/live-columns";
export { exposedColumns } from "./internal/exposed-columns";
export {
  clockField,
  clockFieldTicks,
  clockFieldValue,
  clockFormOf,
  clockInputs,
  clockParam,
  clockParamAt,
  pinNow,
} from "./internal/clock";
export type {
  ClockFieldDef,
  ClockForm,
  ClockParam,
  ClockParamForm,
} from "./internal/clock";
export { clientFields, rowKind } from "./internal/row-kind";
export {
  isRowUnknown,
  rowFailed,
  rowPending,
  RowUnknown,
} from "./internal/row-unknown";
export type { RowFieldState } from "./internal/row-unknown";
export type {
  ClientFields,
  ClientFieldsOwner,
  ClientFieldsOwnerRow,
  ClientFieldValue,
  RowKind,
} from "./internal/row-kind";
export type {
  FieldsRow,
  LabelledKeys,
  LiveField,
  LiveFieldIds,
  LiveFields,
  LiveFieldsSpec,
  LiveFrom,
  LiveRelated,
  RequireLabel,
} from "./internal/live-fields";
export type { DomainOfValue, FieldsFilterable } from "./internal/field-domain";
export { extentOf } from "./internal/field-extent";
export type { FieldCellContext, FieldExtent } from "./internal/field-extent";
export type { LiveExposedColumns } from "./internal/exposed-columns";
// A declaration's SHAPE (every list it holds, capped or whole — the
// list-bound markers) is walked by `liveValue` / `liveCollection` and a bare
// list refused at declaration; its FRESHNESS is the serve call's `changes`.
export { liveValue } from "./internal/live-value";
export type {
  LiveMachineDecl,
  LivePortableDecl,
} from "./internal/needs-machine";
export { LIVE_QUERY_MAX_BYTES } from "./internal/query-value";
export type {
  LiveKeyCut,
  LiveKeyRange,
  LivePageBounds,
  LivePagedCodec,
  LivePagedParams,
  LiveQueryCodec,
  LiveQueryParams,
  LiveQuerySchema,
} from "./internal/query-value";
export type {
  LiveBytesBrand,
  LiveBytesParamValueSpec,
  LiveBytesQueryValueSpec,
  LiveBytesSpecBase,
  LiveBytesTypedParamValueSpec,
  LiveCentralValueSpec,
  LiveKeyDirection,
  LivePagedKey,
  LivePagedPages,
  LivePagedSpec,
  LivePagedValue,
  LivePagedValueSpec,
  LiveParamValueSpec,
  LivePlainValue,
  LivePreloadedParamValue,
  LivePreloadedParamValueSpec,
  LiveTypedParamValueSpec,
  LiveTypedValueParams,
  LiveQueryValue,
  LiveQueryValueSpec,
  LiveRefusals,
  LiveRefusalsBrand,
  LiveSnapshotBrand,
  LivePersistableBrand,
  LiveTooLarge,
  LiveValue,
  LiveValueOrigin,
  LiveValueParamParsers,
  LiveValueParams,
  LiveValueSpec,
} from "./internal/live-value";
export type {
  LiveAllCollection,
  LiveAllOrder,
  LiveArms,
  LiveArmsCollection,
  LiveCollection,
  LiveCollectionOf,
  LiveCountCodec,
  LiveCountDescriptor,
  LiveCountedCollection,
  LiveExposes,
  LiveScopedColumnsOf,
  LiveFieldsDefault,
  LiveFieldsForm,
  LiveGroupCodec,
  LiveGroupsDescriptor,
  LiveLookupCollection,
  LiveNoWindowCollection,
  LivePreload,
  LiveRowsCollection,
  LiveRowSchema,
  LiveTree,
  LiveTreeCollection,
  LiveWindowCodec,
  LiveWhereOf,
  LiveWindowDescriptor,
  TreeRow,
} from "./internal/live-collection";
export {
  LIVE_CHILD_COUNT_KEY,
  LIVE_TREE_ANCESTORS_MAX,
  LIVE_TREE_MAX_DEPTH,
} from "./internal/live-collection";
export { LIVE_ROW_KEY, LIVE_ROW_KEY_MAX_BYTES } from "./internal/row-key";
// The one serving code path every host runs (Bun server, central, a browser
// server) — `serve-on.ts`. Classified as serving primitives (not factories) by
// `tooling/resource-vocabulary`.
export { serveCollectionOn, serveValueOn } from "./internal/serve-on";
export type {
  ExternalAllCollection,
  ExternalLookupCollection,
  ExternalSourceRow,
  ExternalWindowCollection,
  ExternalNotifiedPagedValue,
  ExternalNotifiedQueryValue,
  ExternalNotifiedValue,
  ExternalSilentPagedValue,
  ExternalSilentValue,
  LiveCollectionChange,
  LiveCollectionChanges,
  LiveHost,
  LiveHostSource,
  LiveHostSources,
  ServedExternalAll,
  ServedExternalLookup,
  ServedExternalResource,
  ServedExternalWindow,
  ServedPagedOn,
  ServedValueOn,
  ServeExternalAllOptions,
  ServeExternalLookupOptions,
  ServeExternalWindowOptions,
  ServeValueOnOptions,
} from "./internal/serve-on";
export type { LiveRuntime } from "./internal/compile-value";
export type { LiveCutKey } from "./internal/row-key";
export type {
  LiveColumnFilter,
  CollectionKindKey,
  LiveCountParams,
  LiveCountQuery,
  LiveDecodedCountQuery,
  LiveDecodedGroupQuery,
  LiveDecodedQuery,
  LiveFilterable,
  LiveFilterableOf,
  LiveGroup,
  LiveGroupableColumn,
  LiveGroupableDomain,
  LiveGroupParams,
  LiveGroupQuery,
  LiveGroupValue,
  LiveIdsQuery,
  LiveOrderBy,
  LiveQuery,
  LiveQueryFilterable,
  LiveQueryGroupable,
  LiveQuerySortable,
  LiveQueryWhere,
  LiveReservedColumn,
  LiveRowQuery,
  LiveScopedAllQuery,
  LiveSortDirection,
  LiveWhere,
  LiveWhereObject,
  LiveWindowBounds,
  LiveWindowParams,
} from "./internal/query";
export { COLLECTION_KIND_KEYS } from "./internal/query";
export {
  compilePagedValue,
  compileQueryValue,
  compileValue,
} from "./internal/compile-value";
export type {
  AnyServeOptions,
  BytesPairing,
  CompiledPagedValue,
  CompiledValue,
  ExternalServed,
  LiveValueChanges,
  LiveValueSource,
  PagedChanges,
  ServePagedValueOptions,
  ServeValueOptions,
  ServedFor,
  ServedValueBase,
  SnapshotPairing,
  NotifyValue,
  ValueChange,
} from "./internal/compile-value";
export {
  FOLLOW_SOURCE,
  followReaches,
  followsAtBind,
  followsDeferred,
  followsOf,
  followSubjectOf,
} from "./internal/follows";
export type {
  Follow,
  FollowBuilder,
  FollowIds,
  FollowIdsSource,
  FollowIdsTarget,
  FollowMap,
  FollowsFn,
  FollowWhere,
  FollowWhereSource,
  FollowWhereTarget,
  NoFollows,
} from "./internal/follows";
export { sliceRange } from "./internal/key-order";
export {
  compileExternalCollection,
  externalCollectionRegistrar,
} from "./internal/serve-on";
export type {
  AnyCollection,
  AnyExternalCollectionOptions,
  AnyServedExternal,
  ChangeHooks,
  ExternalCollectionChangeOptions,
} from "./internal/serve-on";
