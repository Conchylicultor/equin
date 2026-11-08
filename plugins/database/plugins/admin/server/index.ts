import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  getAdminPool,
  closeAdminPool,
  openShortLivedClient,
  openHeldClient,
  connectionString,
} from "./internal/pool";
export {
  listDatabases,
  databaseExists,
  dropDatabase,
  ensureDatabase,
  countActiveConnections,
  databaseSizeBytes,
} from "./internal/databases";
export { forkDatabase } from "./internal/fork";
export type { ForkOutcome } from "./internal/fork";
// What the fork found while matching the declared set against the source
// catalog: `ForkPlanError` is the deterministic refusal (see ./internal/fork-plan
// for the two states that earn it), and the rest is what a caller with a human
// or a bell should surface.
export { describeUndeclaredSchema, ForkPlanError } from "./internal/fork-plan";
export type { ForkPlan, UndeclaredSchema } from "./internal/fork-plan";
// A plugin declares "don't fork my data" for its own table / schema (see
// ./internal/fork-exclusion for the trade this makes); `forkExclusions` (a
// booted backend) / `forkExclusionsFrom` (loaded definitions, no backend) is
// the declared set every `forkDatabase` caller must pass.
export {
  ExcludeFromFork,
  ExcludeSchemaDataFromFork,
  forkExclusions,
  forkExclusionsFrom,
} from "./internal/fork-exclusion";
export type {
  ForkExclusions,
  ForkSchemaExclusion,
} from "./internal/fork-exclusion";
export { forkTempPrefix, isForkTempName } from "./internal/temp-name";
export { reclaimForkTemp } from "./internal/fork-lease";
export { backupDatabase, inspectBackup } from "./internal/backup";
export type { BackupInfo, TableStat } from "./internal/backup";
// `BackupPlanError` is the backup's deterministic refusal, in strict mode only
// (the running namespace's own database): a kept table links to a table whose
// rows are left out, so the archive could not be restored. Any other database
// keeps those rows instead and reports them as `keptForLinks`.
export { BackupPlanError } from "./internal/backup-plan";
export type { BackupPlan, KeptForLink } from "./internal/backup-plan";
// A plugin declares "my rows can be left out of the backup" for its own table
// (see ./internal/backup-exclusion for the two reasons that qualify);
// `backupExclusions` is the collected set every `backupDatabase` caller passes.
export {
  ExcludeFromBackup,
  backupExclusions,
} from "./internal/backup-exclusion";
export type { BackupExclusions } from "./internal/backup-exclusion";

export default {
  description:
    "Admin operations for the database plugin — fork, backup, drop, list.",
} satisfies ServerPluginDefinition;
