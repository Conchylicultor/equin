import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { eventsDispatchJob } from "./internal/dispatch-job";
import { jobEventTriggerSource } from "./internal/background-trigger-source";
import { jobsHooksRegistration } from "./internal/install-jobs-hooks";
import {
  handleListEmissions,
  handleListTriggers,
  handleDeleteTrigger,
  handlePatchTrigger,
} from "./internal/handle";
import {
  eventEmissionsServed,
  eventTriggersServed,
} from "./internal/resources";
import {
  syncTriggerContributions,
  sweepStaleTriggers,
} from "./internal/trigger-contributions";
import {
  listEmissions,
  listTriggers,
  deleteTriggerEndpoint,
  patchTriggerEndpoint,
} from "../core/endpoints";

export { defineTriggerEvent } from "./internal/event";
export type {
  DefineTriggerEventSpec,
  EmitTx,
  EventHandle,
  EventSource,
  FilterSlot,
} from "./internal/event";
export { triggerTableRegistry } from "./internal/registry";
export { _event_emissions } from "./internal/tables";
export {
  deleteTrigger,
  deleteTriggersFor,
  trigger,
  UNSAFE_triggerByName,
} from "./internal/trigger";
export type { TriggerSpec, UnsafeTriggerByNameSpec } from "./internal/trigger";
export { Trigger } from "./internal/trigger-contributions";

export default {
  portable: true,
  description:
    "Event→job bindings layered on @plugins/jobs. Plugins declare events with typed filter columns via defineTriggerEvent, subscribers bind jobs via trigger(). Contributes a BackgroundTriggerSource so the Background activity catalog names the events that start each job.",
  loadBearing: true,
  httpRoutes: {
    [listEmissions.route]: handleListEmissions,
    [listTriggers.route]: handleListTriggers,
    [deleteTriggerEndpoint.route]: handleDeleteTrigger,
    [patchTriggerEndpoint.route]: handlePatchTrigger,
  },
  register: [eventsDispatchJob, jobsHooksRegistration],
  contributions: [
    ...eventEmissionsServed.declare,
    ...eventTriggersServed.declare,
    jobEventTriggerSource,
  ],
  onReady: async () => {
    await syncTriggerContributions();
    await sweepStaleTriggers();
  },
} satisfies ServerPluginDefinition;
