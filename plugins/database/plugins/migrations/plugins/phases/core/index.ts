export {
  migrationClaimId,
  parseMigration,
  renderAdoptionMigration,
  renderMergeSnapshotMigration,
  renderPhasedMigration,
  renderSnapshotHeader,
  snapshotLineage,
} from "./internal/phases";
export type {
  ParsedMigration,
  PhasedMigration,
  SnapshotLineage,
  Supersession,
} from "./internal/phases";
