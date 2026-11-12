import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import {
  hostIdleBegan,
  hostIdleEnded,
} from "@plugins/infra/plugins/host/plugins/idle/server";
import { testDigestsSettled } from "@plugins/debug/plugins/tests/server";
import {
  idleBatchJob,
  idleBeganJob,
  idleEndedJob,
  idleNextJob,
} from "./internal/idle-runner";

export default {
  description:
    "Runs stale and never-run test files while the host is idle: on host.idleBegan it brings the checkout's test digests current; each tests.digestsSettled (and each batch's end, after its record is ingested) starts the next tests.idle-batch — `./equin test` on files chosen by selectIdleBatch, opportunistic, origin idle — while the host is still idle; host.idleEnded cancels the running batch.",
  register: [idleBatchJob, idleNextJob, idleBeganJob, idleEndedJob],
  contributions: [
    Trigger({ on: hostIdleBegan, do: idleBeganJob, with: {}, oneShot: false }),
    Trigger({ on: hostIdleEnded, do: idleEndedJob, with: {}, oneShot: false }),
    Trigger({
      on: testDigestsSettled,
      do: idleNextJob,
      with: {},
      oneShot: false,
    }),
  ],
} satisfies MachinePluginDefinition;
