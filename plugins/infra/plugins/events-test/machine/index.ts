import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { handleCrashRecovery } from "./internal/crash-recovery";
import { handleQueueLockNoSteal } from "./internal/queue-lock-no-steal";
import { handleSuperseded, supersededProbe } from "./internal/superseded";
import {
  crashRecoveryEventsTest,
  queueLockNoStealEventsTest,
  supersededEventsTest,
} from "../shared/endpoints";

// The harnesses that read the desktop's graphile queue (its introspection and
// stuck-lock sweeper, `infra/jobs#machine`). Raw handlers: each returns its own
// verdict status.
export default {
  description:
    "The events-test harnesses of the desktop's graphile queue: exact job liveness (crash-recovery), the queue-level lock no-steal, and superseded rows.",
  httpRoutes: {
    [crashRecoveryEventsTest.route]: machineHandler(handleCrashRecovery),
    [queueLockNoStealEventsTest.route]: machineHandler(handleQueueLockNoSteal),
    [supersededEventsTest.route]: machineHandler(handleSuperseded),
  },
  register: [supersededProbe],
} satisfies MachinePluginDefinition;
