export { schemaGlobFiles } from "./internal/schema-glob";
// "Does every schema-glob file load the way drizzle-kit loads it?" — asked by
// the `schema-files-loadable` check and by the CLI's `generateMigration` before
// it trusts a drizzle-kit run (which drops an unloadable file silently).
export { schemaLoadFailures } from "./internal/schema-load-probe";
export type { SchemaLoadFailure } from "./internal/schema-load-probe";
// The repo-relative DEV-TREE location of this plugin — drizzle-kit's cwd for
// every sanctioned invocation, and the anchor its relative config paths resolve
// against. Public because the two invocation sites live in other plugins
// (checks/migrations-in-sync, cli/plugins/migrations/cli/migrations.ts); a hand-written copy that
// drifts points migration generation at a directory where the schema globs match
// nothing, which drizzle-kit reports as success. NOT the runtime migrations dir
// (see the declaration's docblock). `SCHEMA_GLOBS` stays internal — no consumer.
export { MIGRATIONS_PLUGIN_DIR } from "./internal/schema-glob-patterns";
// The argv for a sanctioned `generate` run. Public for the same reason
// MIGRATIONS_PLUGIN_DIR is: both invocation sites live in other plugins
// (checks/migrations-in-sync, cli/plugins/migrations/cli/migrations.ts). It takes typed FLAGS, so
// no caller can produce a subcommand other than `generate` — the dialing ones
// are unsupported through drizzle.config.ts's sentinel credentials.
// `DRIZZLE_KIT_BIN` stays internal: its only other reader is this plugin's own
// lint rule, which imports it relatively. `DRIZZLE_CONFIG_PATH` is public for
// migrations-in-sync, whose throwaway config extends the real one.
export {
  drizzleGenerateArgv,
  DRIZZLE_CONFIG_PATH,
} from "./internal/drizzle-cli";
export type { DrizzleGenerateOptions } from "./internal/drizzle-cli";
// The phased-migration file grammar, shared by the generator (cli) and the
// runner (server). See research/2026-09-29-global-phased-migrations.md.
export {
  migrationClaimId,
  parseMigration,
  renderAdoptionMigration,
  renderMergeSnapshotMigration,
  renderPhasedMigration,
  renderSnapshotHeader,
  snapshotLineage,
} from "./internal/phases";
// The snapshot DAG (prevId edges + merge-node parents): one definition of its
// edges for the CLI's tip join and the snapshot-chain-intact check, and the
// single-tip out-dir every drizzle-kit run reads instead of data/ (drizzle-kit
// aborts on a merged history). See
// research/2026-09-30-global-clone-migrations-published-set.md §3.
export {
  analyzeSnapshotDag,
  declaredParents,
  NULL_SNAPSHOT_ID,
  readSnapshotNodes,
  schemaSnapshotState,
  snapshotAncestors,
} from "./internal/snapshot-dag";
export type {
  SnapshotDag,
  SnapshotDagProblem,
  SnapshotNode,
} from "./internal/snapshot-dag";
// The files under data/meta/ that record the chain — the live tip body
// (`schema.snapshot.json`), the frozen pre-cutover lineage
// (`legacy-snapshots.json`) — and THE schema-migration predicate every
// consumer asks instead of looking for a sibling snapshot. See
// research/2026-10-22-global-single-live-migration-snapshot.md.
export {
  isSchemaMigration,
  legacySnapshotFiles,
  legacySnapshotsPath,
  readLegacySnapshots,
  readSnapshotHead,
  renderLegacySnapshots,
  SCHEMA_SNAPSHOT_FILE,
  schemaMigrationFiles,
  schemaSnapshotPath,
} from "./internal/schema-snapshot";
// The 3-way snapshot merge, and a merge node's body as a pure function of its
// parents: the CLI's tip join writes it, the body resolver recomputes it.
export {
  equivalentSnapshots,
  formatSnapshotConflict,
  mergeSnapshots,
} from "./internal/snapshot-merge";
export type { Snapshot, SnapshotConflict } from "./internal/snapshot-merge";
export { foldMergeParents, mergeNodeSnapshotText } from "./internal/merge-node";
// Historical snapshot bodies, from the working tree, a merge node's parents, or git.
export { snapshotBodies } from "./internal/snapshot-bodies";
export type { SnapshotBodies } from "./internal/snapshot-bodies";
export {
  stageDrizzleOut,
  UnjoinedSnapshotTipsError,
} from "./internal/drizzle-stage";
export type { DrizzleStage, EmittedSnapshot } from "./internal/drizzle-stage";
export type {
  ParsedMigration,
  PhasedMigration,
  SnapshotLineage,
  Supersession,
} from "./internal/phases";
// The one statement splitter for migration SQL (comment/literal/dollar-quote
// aware), shared by the phaser and the data-migration-dml-only and
// fork-schema-drift checks.
export { splitStatements } from "./internal/statements";
export type { Statement } from "./internal/statements";
// The closed expand / contract / reject statement table the generator phases a
// schema migration with, and the migration-phases-valid check re-runs.
export {
  classifyStatement,
  phaseStatements,
  renderStatements,
} from "./internal/classify";
export type {
  ContractOp,
  ExpandOp,
  PhasedStatements,
  RejectOp,
  StatementClass,
  StatementOp,
} from "./internal/classify";
// What "published" means for a migration — on any `main` this checkout knows
// of (local `main` or `refs/remotes/<remote>/main`) — and the rule that a
// published migration is immutable. One spelling for the CLI's generate
// pipeline, regen-migrations, and every migration check. See
// research/2026-09-30-global-clone-migrations-published-set.md.
export {
  LOCAL_MAIN_REF,
  MIGRATIONS_DATA_DIR,
  publishedMergeBases,
  publishedMigrationBasenames,
  publishedMigrationOrigins,
  publishedMigrationRefs,
  publishedMigrationRefsSignature,
} from "./internal/published";
export type { PublishedMergeBase, PublishedRef } from "./internal/published";
export {
  findPublishedMigrationViolations,
  formatPublishedMigrationViolations,
  migrationContentHash,
  PUBLISHED_MIGRATION_HINT,
} from "./internal/published-immutable";
export type { PublishedMigrationViolation } from "./internal/published-immutable";
