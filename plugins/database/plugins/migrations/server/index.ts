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
  SchemaLayerResult,
  SchemaPlan,
  SchemaPlanOptions,
  SchemaStep,
} from "./internal/runner";
export { MigrationSource } from "./internal/source";
export type { MigrationSourceImpl } from "./internal/source";

export default {
  description: "DDL lifecycle: migration runner and SQL files.",
  portable: true,
} satisfies ServerPluginDefinition;
