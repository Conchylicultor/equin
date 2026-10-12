/**
 * The machinery an OP command runs on — the shared half of `build`, `check`,
 * `test`, `push` and the e2e branch of `run`: broadcasts, the deploy receipt,
 * fatal-signal exits, signal-origin attribution, lane classification, the op
 * profiler and durable progress log, the duress admission valve, the
 * nested-check subprocess, build output rendering, crash recording, and the
 * whole lifecycle of a DIRECT op (`withDirectOp`, ./direct-op.ts).
 *
 * Why a plugin rather than loose files beside the commands: once each command
 * is its own sub-plugin, a sibling cannot reach the host's `bin/`, and `shared/`
 * is plugin-private (cross-plugin `shared/` imports are forbidden by R10). A
 * `cli/` barrel is the sanctioned way for one CLI plugin to share code with
 * another — the same shape `e2e/` uses for the shared Playwright harness.
 *
 * NOTHING HERE MAY IMPORT A COMMAND. The dependency runs commands → op-runtime,
 * never back; the `cli` runtime's R6 graph has to stay a DAG. This barrel does
 * not import `bootstrap` either — keeping the two apart is what lets the
 * bootstrap closure stay npm-free while this one is unconstrained.
 *
 * THE DEPLOY RECEIPT LIVES IN `core/`, not here. It is a record on disk, and
 * reading a record is not a CLI act: the e2e harness has to prove that the
 * deploy answering its target is the build that checkout published, and the
 * `e2e` runtime may reach a plugin's `core` barrel but never its `cli` one.
 * `./build-receipt` below is a shim onto `../core/internal/build-receipt`, so
 * the op commands that write the receipt are unaffected by the move.
 *
 * NO PATH RE-EXPORTS. There used to be a `paths.ts` here whose entire content
 * was re-exporting `worktreeArtifacts` / `PG_LOG_FILE` / … from the plugins that
 * own them. That was only ever legal because `bin/` is outside the boundary
 * rules; a `cli/` barrel surfacing another plugin's names is a
 * `cross-plugin-reexport` violation, detected transitively. Consumers import
 * from the owning barrel (`@plugins/infra/plugins/paths/server`,
 * `@plugins/database/plugins/embedded/server`) — which most of the tree already
 * did, and which honours the original file's own rule that a path is named once,
 * by its owner, never re-derived.
 */

export { checkBroadcasts } from "./broadcasts";

export {
  readBuildReceipt,
  reportInterruptedPredecessor,
  resolveBuildReceipt,
  writeBuildReceipt,
} from "./build-receipt";
export type {
  BuildReceipt,
  BuildReceiptStatus,
  ResolvedReceipt,
} from "./build-receipt";

export { FATAL_SIGNAL_EXITS, installFatalSignalExit } from "./fatal-signals";
export type {
  FatalSignal,
  FatalSignalExitOptions,
  SignalTermination,
} from "./fatal-signals";

export { signalOriginTap } from "./signal-origin-tap";
export type { SignalOriginTapOptions } from "./signal-origin-tap";

export { LANE_ENV, laneFor, publishLane } from "./lane";

export { withDirectOp } from "./direct-op";
export type {
  DirectOpContext,
  DirectOpDeps,
  DirectOpFlight,
  DirectOpOptions,
  JoinedRun,
} from "./direct-op";

export {
  buildProfilerStart,
  pushBuildSpan,
  writeBuildProfile,
} from "./profiler";
export type { BuildProfile, BuildSpan } from "./profiler";

export {
  PROGRESS_FILE,
  finishBuildProgress,
  openBuildProgress,
  readBuildProgress,
} from "./build-progress";
export type { BuildProgressRecord, BuildRunProgress } from "./build-progress";

export {
  MAX_VALVE_HOLD_MS,
  checkValveGuard,
  createValveDeps,
  holdThroughValve,
  shouldRequeue,
  valveGates,
} from "./admission-valve";
export type { HoldOutcome, ValveDeps } from "./admission-valve";

export { runCheckSubprocess } from "./check-subprocess";
export type {
  CheckSubprocessOptions,
  CheckSubprocessResult,
} from "./check-subprocess";

export {
  emitVerdict,
  installVerdictGuard,
  printStepBlocks,
  renderVerdict,
} from "./build-output";
export type { Verdict } from "./build-output";

export { pushBuildStepLog, writeBuildLogs } from "./build-logs-writer";
export type { BuildLogs, BuildStepLog } from "./build-logs-writer";

export { readCliCrash, recordCliCrash } from "./cli-crash";
