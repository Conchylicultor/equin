export {
  fileReportFromProcess,
  fileReportFromProcessSync,
  OUTBOX_MAX_PENDING,
  repositoryOf,
} from "./internal/file-report";
export type { FileReportOutcome } from "./internal/file-report";
export { headCommitOf, mergeBaseWithMain } from "./internal/merge-base";
export type { MergeBaseResult } from "./internal/merge-base";
export {
  OutboxCodeSchema,
  OutboxEntrySchema,
  isOutboxEntryName,
  isOutboxTempName,
} from "./internal/entry";
export type { OutboxCode, OutboxEntry, ProcessReport } from "./internal/entry";
