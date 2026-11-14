import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import {
  eventMessageIdKind,
  pendingEventIdKind,
  routeEventStream,
  updateEventSettings,
} from "../core";
import {
  eventMessagesServed,
  eventPendingServed,
  eventRoutesServed,
  eventSettingsServed,
} from "./internal/resources";
import {
  handleRouteEventStream,
  handleUpdateEventSettings,
} from "./internal/routes";
import { eventStreamsServed } from "./internal/streams";
import { readEventMessageTool } from "./internal/tools";

export { SupervisorEventStream, streamLabel } from "./internal/streams";
export type { SupervisorEventStreamSpec } from "./internal/streams";
export {
  _supervisorEventMessages,
  _supervisorEventPending,
  _supervisorEventRoutes,
  _supervisorEventSettings,
} from "./internal/tables";

export default {
  description:
    "Supervisor event streams, data half: a SupervisorEventStream contribution names a stream of events (error reports, slow ops…), fed by its plugin through the desktop's publishSupervisorEvent; each stream is routed to at most one role (PUT /api/supervisor-events/streams/:streamId, optionally narrowed to some kinds), and each role sets how its messages are spaced (gapMinutes, default 10) and what happens with no live session — drop (default), file in backlog, launch a session (PATCH /api/supervisor-roles/:id/events). Served live: the streams, the routes, each role's settings, what it is gathering and its last 50 messages. The read_event_message MCP tool (gated on the role powers) reads every line of one of the caller's role's messages.",
  httpRoutes: {
    [routeEventStream.route]: handleRouteEventStream,
    [updateEventSettings.route]: handleUpdateEventSettings,
  },
  register: [readEventMessageTool],
  contributions: [
    IdKinds.Kind({ kind: eventMessageIdKind }),
    IdKinds.Kind({ kind: pendingEventIdKind }),
    ...eventStreamsServed.declare,
    ...eventRoutesServed.declare,
    ...eventSettingsServed.declare,
    ...eventPendingServed.declare,
    ...eventMessagesServed.declare,
  ],
} satisfies ServerPluginDefinition;
