import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  deferredWindowQueryResource,
  windowQueryResource,
} from "./internal/compile-window";
export { compileGroupsQuery } from "./internal/compile-groups";
export { compileCountQuery } from "./internal/compile-count";
export type { CompiledCount } from "./internal/compile-count";
export { compileAllCollection } from "./internal/compile-alias";
export type {
  AllBind,
  AllCollectionContracts,
  AllCollectionSpec,
  CompiledAllCollection,
} from "./internal/compile-alias";
export { compileUnionCollection } from "./internal/compile-union-window";
export type {
  CompiledUnion,
  UnionArmSpec,
  UnionCollectionSpec,
  UnionColumn,
  UnionCuts,
  UnionGroupsQuery,
  UnionOrderKey,
} from "./internal/compile-union-window";
export { compileJoins, joinRefs, presenceExpr } from "./internal/joins";
export { compiledValueReach } from "./internal/routes";
export type { ValueReads } from "./internal/routes";
export type { ReadColumn } from "./internal/joins";
export type { CompiledGroups } from "./internal/compile-groups";
export type {
  EntitySource,
  PointQueryResourceSpec,
  QueryDb,
  RoutedSource,
  SelectMap,
  WindowOrderKey,
  WindowQueryResourceSpec,
} from "./internal/spec";

export default {
  description:
    "Declarative SQL query→resource compiler: one drizzle-based declaration derives the loader, scoped loader, scope policy (the routes the change router serves it by, for a bounded window / point set, a whole ordered set declared `all` — compileAllCollection, grouped CTEs over rollup / children / closure joins — and a grouping), and client keyOf for live-state resources.",
} satisfies ServerPluginDefinition;
