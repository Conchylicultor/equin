import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { supervisedJobRunsRetention } from "./internal/retention";
import {
  reconcileSupervisedRuns,
  supervisedRunLivenessTimer,
  supervisedRunWatcher,
} from "./internal/run/supervisor";
import { _supervisedJobRuns } from "./internal/tables";
import { runEnded } from "./internal/tables-run-ended";

export { defineSupervisedJob } from "./internal/define-supervised-job";
export type {
  DefineSupervisedJobSpec,
  SupervisedJob,
  SupervisedJobClaimMeta,
  SupervisedJobEndedMeta,
  SupervisedJobLedger,
  SupervisedJobSpawn,
  SupervisedRunContext,
  SupervisedStepsContext,
} from "./internal/define-supervised-job";
export type { RunStep, StepOutcome } from "./internal/steps";
export {
  cancelSupervisedJob,
  cancelSupervisedJobByLock,
} from "./internal/cancel";
export type { CancelByLockResult } from "./internal/cancel";
export { latestSupervisedRun } from "./internal/latest-run";
export type { SupervisedRunRow } from "./internal/builtin-ledger";
// A reader of one run's files (build-logs' persisted log) hears the
// supervisor's own pumps and settles instead of opening a second watch of the
// runs dir — read-only, it starts and stops nothing.
export { onSupervisedRunChange } from "./internal/run/observers";
// The type a consumer's ledger implements (`listUnfinished` returns these).
export type { UnfinishedRun } from "./internal/run/registry";
// The built-in ledger's table, exported for drizzle-kit's table discovery.
export { _supervisedJobRuns } from "./internal/tables";
// Deliberately NOT exported: the supervisor (`startSupervisedRun`,
// `killSupervisedRun`, `defineSupervisedRunKind`) and the observe-then-wait loop
// (`awaitSupervisedRun`). `defineSupervisedJob` is the one way to start a
// detached child — a workflow owning several sequential children uses its
// `steps` body — so none of them has a spelling outside this plugin.
// `_supervisedRunEndedTriggers` is exported for drizzle-kit alone: it discovers
// tables by filename glob, and a table it cannot see is a table it emits a
// spurious DROP for.
export {
  runEnded,
  _supervisedRunEndedTriggers,
} from "./internal/tables-run-ended";
export type { RunEndedPayload } from "./internal/tables-run-ended";

export default {
  description:
    "Out-of-process work as an ordinary job: defineSupervisedJob composes defineJob + a supervised-run kind into a handler that claims, spawns detached and SUSPENDS — so no worker slot is held while the child runs — then wakes on the supervisedRun.ended event, re-reads the child's exit marker (the authority; the event is only a wake-up) and records the outcome, surviving any number of backend restarts in between.",
  // The event's own table, mounted here so the register phase completes before
  // any consumer's `onReady` can emit or subscribe. Every supervised job's kind
  // registers itself through its own `defineSupervisedJob` token.
  register: [
    runEnded,
    supervisedJobRunsRetention,
    supervisedRunWatcher,
    supervisedRunLivenessTimer,
  ],
  contributions: [
    ExcludeFromFork({
      table: _supervisedJobRuns,
      reason:
        "Runs of this backend's own detached children, closed from exit markers on this machine; an inherited open row would hold a job's lock in a fresh worktree until the reconciler wrote it off as a hard kill.",
    }),
  ],
  // The reconciler is registered ONCE here, not once per consumer, and this is
  // where the duplication actually dies: `reconcileOrphanBuilds` and
  // `reconcileOrphanReleases` are two near-copies of one loop, and each solved a
  // different subset of the problem. `onReady` rather than `onReadyBlocking`
  // because nothing about serving a request depends on it — a run adopted a
  // second late is a run adopted.
  onReady: () => reconcileSupervisedRuns(),
} satisfies ServerPluginDefinition;
