import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  applySchemaLayer,
  completeDeferredContract,
  generationsKnowing,
  migrationsReady,
  dryRunPendingMigrations,
  isMigrationFileName,
  migrationsFrom,
  planSchemaSteps,
  schemaGeneration,
} from "./internal/runner";
export type {
  Migration,
  SchemaLayerInputs,
  SchemaLayerOptions,
  SchemaLayerResult,
  SchemaPlan,
  SchemaPlanOptions,
  SchemaStep,
} from "./internal/runner";
export {
  recordSchemaLayerStamp,
  SCHEMA_STAMPED_CHANNEL,
} from "./internal/layer-stamp";
export { verifySchemaLayer } from "./internal/layer-verify";
export type { SchemaLayerCheck } from "./internal/layer-verify";
export { MigrationSource } from "./internal/source";
export type { MigrationSourceImpl } from "./internal/source";

export default {
  description: "DDL lifecycle: migration runner and SQL files.",
} satisfies ServerPluginDefinition;
