// `OpKind` is NOT re-exported here: it is `infra/worktree/core`'s declaration,
// and a barrel surfacing another plugin's symbol hides the real dependency.
export type {
  LegacyOpenWait,
  OpClosedBy,
  OpEvent,
  OpEventKind,
  OpFoldState,
  OpIdentity,
  OpLine,
  OpLiveTimes,
  OpOutcome,
  OpRecord,
  OpSleep,
  OpSleepStamp,
  OpStep,
  OpSummary,
  OpWait,
  OpWaitSpan,
  OpenWait,
  OutcomeByKind,
  RawOpRecord,
  SleepStamp,
  TerminalOutcome,
  WaitKind,
  WaitKindMeta,
  WaitResult,
} from "./internal/types";
export { WAIT_KINDS } from "./internal/types";
export {
  linePositionText,
  waitLineOf,
  waitersAhead,
} from "./internal/wait-line";
export type { LineOp } from "./internal/wait-line";
export {
  advanceSleeps,
  applyOpEvent,
  emptyOpState,
  foldOpLines,
  isOpEvent,
  isTerminalState,
  liveTimes,
  orphanedOps,
  reconcilerCompletedEvent,
  sumWaits,
  toOpRecord,
  toOpRecords,
} from "./internal/fold";
