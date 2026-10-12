import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  compileCollection,
  serveCollection,
} from "./internal/serve-collection";
export { serveValue } from "./internal/serve-value";
export { sliceRange } from "../shared/key-order";
export { serveUnionCollection } from "./internal/serve-union";
export type {
  ServeUnionOptions,
  UnionArmBinding,
  UnionArmColumns,
  UnionArmRefs,
  UnionFieldBinding,
} from "./internal/serve-union";
export {
  LiveColumns,
  serveColumns,
  serveScopedColumns,
} from "./internal/serve-columns";
export type {
  ScopedMemberRead,
  ServedColumns,
  ServedScopedColumns,
} from "./internal/serve-columns";
export {
  compilePagedValue,
  compileQueryValue,
  compileValue,
} from "../shared/compile-value";
export type {
  ServedExternalQueryValue,
  ServedExternalValue,
  ServedPagedValue,
  ServedSilentPagedValue,
  ServedValue,
} from "./internal/serve-value";
export type {
  CompiledPagedValue,
  CompiledValue,
  LiveValueSource,
  ServePagedValueOptions,
  ServeValueOptions,
} from "../shared/compile-value";
export type {
  AllCollectionSpecs,
  AllWhereColumns,
  ServeAllCollectionOptions,
} from "./internal/serve-all";
export type { CollectionSource } from "./internal/collection-source";
export type {
  CollectionSpecs,
  ColumnOverride,
  DefaultScope,
  LookupCollectionSpecs,
  ServeCollectionOptions,
  ServedAllCollection,
  ServedCollection,
  ServedLookupCollection,
} from "./internal/serve-collection";

export default {
  description:
    "Unified live-resource API, server half: serveValue (a liveValue's loader, from Postgres — change-feed driven, a collection-shaped payload must declare `unbounded: { reason }` — or from an external source with notify(); pushed by default, or refetched over HTTP when the liveValue declares `load: \"on-demand\"`; a typed-query value's hooks and notify take the decoded question, and a key-range-paged one — external only — is loaded one key range at a time, each answer checked against its range and minted its `$key`, notify(q) reaching every subscribed page and the per-question meta sibling, and sliceRange answers a range for a list held in memory) and serveCollection (binds a liveCollection's row fields to a table's columns — the projection is exactly the row schema — ANDs an optional base `where` into every read, and compiles its window + `:rows` point resources through windowQueryResource and its `:groups` GROUP BY push value — only `:rows` for a lookup-only collection, and the whole ordered set (`key`, a routed scopedMembership alias compiled by compileAllCollection) + `:rows` for one declared `all` — encoding a column type's declared wire form in JS per row; a `contributed` collection compiles at boot, folding every LiveColumns.Serve contribution naming it — serveColumns(handle, { join }) — into its rows' `$columns`); every filter compiles through the filter language's filterSql.",
} satisfies ServerPluginDefinition;
