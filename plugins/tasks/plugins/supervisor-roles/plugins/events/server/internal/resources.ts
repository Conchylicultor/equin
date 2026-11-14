import { serveCollection } from "@plugins/network/plugins/live/server";
import {
  eventMessages,
  eventPending,
  eventRoutes,
  eventSettings,
} from "../../core";
import {
  eventMessagesEntity,
  eventPendingEntity,
  eventRoutesEntity,
  eventSettingsEntity,
} from "./tables";

export const eventRoutesServed = serveCollection(eventRoutes, {
  from: eventRoutesEntity,
});
export const eventSettingsServed = serveCollection(eventSettings, {
  from: eventSettingsEntity,
});
export const eventPendingServed = serveCollection(eventPending, {
  from: eventPendingEntity,
});
export const eventMessagesServed = serveCollection(eventMessages, {
  from: eventMessagesEntity,
});
