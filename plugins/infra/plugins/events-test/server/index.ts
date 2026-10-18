import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { cronDedupProbe, handleCronDedup } from "./internal/cron-dedup";
import {
  abortSaturationSleepers,
  deadLetterProbe,
  handleQueueSaturate,
  saturateSleeper,
} from "./internal/queue-saturate";
import { handleSerialQueue } from "./internal/serial-queue";
import { serialProbe } from "./internal/serial-job";
import {
  handleDeleteTargeting,
  handleDeleteTrigger,
  handleDirectEnqueue,
  handleEmit,
  handleListTriggers,
  handleLog,
  handleReset,
  handleSubscribe,
  handleWaitIdle,
} from "./internal/handle";
import { detachedSleep, handleDetachedSleep } from "./internal/detached-sleep";
import { logPing } from "./internal/log-job";
import { pinged } from "./internal/tables";
import {
  subscribeEventsTest,
  emitEventsTest,
  directEnqueueEventsTest,
  getEventsTestLog,
  resetEventsTest,
  deleteEventsTestTrigger,
  deleteEventsTestTargeting,
  listEventsTestTriggers,
  waitEventsTestIdle,
  serialQueueEventsTest,
  cronDedupEventsTest,
  queueSaturateEventsTest,
  detachedSleepEventsTest,
} from "../shared/endpoints";

export default {
  description: "Dummy plugin exercising the events and jobs APIs end-to-end.",
  httpRoutes: {
    [subscribeEventsTest.route]: handleSubscribe,
    [emitEventsTest.route]: handleEmit,
    [directEnqueueEventsTest.route]: handleDirectEnqueue,
    [getEventsTestLog.route]: handleLog,
    [resetEventsTest.route]: handleReset,
    [deleteEventsTestTrigger.route]: handleDeleteTrigger,
    [deleteEventsTestTargeting.route]: handleDeleteTargeting,
    [listEventsTestTriggers.route]: handleListTriggers,
    [waitEventsTestIdle.route]: handleWaitIdle,
    [serialQueueEventsTest.route]: handleSerialQueue,
    [cronDedupEventsTest.route]: handleCronDedup,
    [queueSaturateEventsTest.route]: handleQueueSaturate,
    [detachedSleepEventsTest.route]: handleDetachedSleep,
  },
  register: [
    logPing,
    serialProbe,
    cronDedupProbe,
    saturateSleeper,
    deadLetterProbe,
    detachedSleep,
    pinged,
  ],
  onShutdown: abortSaturationSleepers,
} satisfies ServerPluginDefinition;
