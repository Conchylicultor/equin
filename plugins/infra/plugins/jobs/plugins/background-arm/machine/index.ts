import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  onJobRunsChanged,
  onJobSchedulesChanged,
} from "@plugins/infra/plugins/jobs/machine";
import { jobsBackgroundKind } from "./internal/provider";

export default {
  description:
    "Jobs in the Background activity catalog: registers the `job` background kind — every registered job with its trigger (a schedule in words and its next firing, read from graphile's own parse and installed matcher), scope, latest run and recent runs from the jobs run history, retention sweeps grouped as Cleanup and queue plumbing marked internal — and Run now for scheduled jobs; pushes the catalog when a run starts or finishes.",
  register: [jobsBackgroundKind],
  onReady: () => {
    // For the life of the process: the catalog value throttles the pushes.
    onJobRunsChanged((jobName) => jobsBackgroundKind.changed(jobName));
    // A schedule a setting decides moved: every job's next firing reads again.
    onJobSchedulesChanged(() => jobsBackgroundKind.changed());
  },
} satisfies MachinePluginDefinition;
