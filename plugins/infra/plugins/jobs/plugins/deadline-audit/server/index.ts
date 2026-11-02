import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deadlineExceededKind, jobZombieKind } from "./internal/deadline-kinds";
import { slotFloorKind } from "./internal/slot-floor-kind";
import { runnerDiedKind } from "./internal/runner-died-kind";
import {
  registerDeadlineReports,
  unregisterDeadlineReports,
} from "./internal/register";

export { deadlineExceededKind, jobZombieKind } from "./internal/deadline-kinds";
export { slotFloorKind } from "./internal/slot-floor-kind";
export { runnerDiedKind } from "./internal/runner-died-kind";

export default {
  description:
    "Job deadline audit: registers a handler on the jobs plugin's deadline seam and turns each announcement into a report — job-deadline-exceeded (warning) when a run passes its hold class's wall-clock deadline and has ctx.signal aborted, job-zombie (error) when it is still holding its slot a grace period later, job-slot-floor (error) when the written-off slots add up to a runner that can no longer do its job, and job-runner-died (error) when graphile stopped a runner on its own.",
  // `job-slot-floor` and `job-runner-died` have no handler behind them: the report
  // is written by the parent SYNCHRONOUSLY to the crash buffer during a
  // deliberate exit, and replayed by the reports plugin on the next boot. Only
  // the kind has to exist for that replay to resolve — and it does, because
  // contributions are collected before any plugin's onReady, which is when the
  // flush runs.
  contributions: [
    deadlineExceededKind,
    jobZombieKind,
    slotFloorKind,
    runnerDiedKind,
  ],
  onReady: () => {
    registerDeadlineReports();
  },
  onShutdown: () => {
    unregisterDeadlineReports();
  },
} satisfies ServerPluginDefinition;
