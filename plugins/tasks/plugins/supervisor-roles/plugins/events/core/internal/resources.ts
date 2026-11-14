import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  cappedList,
  wholeList,
} from "@plugins/packages/plugins/list-bound/core";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import {
  eventMessagesEntityRef,
  eventPendingEntityRef,
  eventRoutesEntityRef,
  eventSettingsEntityRef,
  MESSAGES_KEPT_PER_ROLE,
  PENDING_PER_ROLE_MAX,
  ROUTE_KINDS_MAX,
} from "./entities";

/** One stream as a reader sees it: what it is, and the kinds it can filter on. */
export const EventStreamInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: SavedSymbolNameSchema,
  description: z.string(),
  kinds: cappedList(z.string(), { max: ROUTE_KINDS_MAX }),
});
export type EventStreamInfo = z.infer<typeof EventStreamInfoSchema>;

/** Every contributed stream — fixed for the process. */
export const eventStreams = liveValue("supervisor-events.streams", {
  schema: wholeList(EventStreamInfoSchema, {
    reason: "the streams plugins contribute — a handful, declared in code",
  }),
});

/** The stream count the routes set is bounded by (one route per stream). */
export const EVENT_ROUTES_MAX = 50;

/** Where every stream goes: the whole set (one row per routed stream). */
export const eventRoutes = liveCollection("supervisor-events.routes", {
  from: eventRoutesEntityRef,
  carry: { pick: ["streamId", "roleId", "kinds"] },
  id: "streamId",
  all: { orderBy: [["streamId", "asc"]], max: EVENT_ROUTES_MAX },
});

/** One role's settings, by role id (no row: the defaults). */
export const eventSettings = liveCollection("supervisor-events.settings", {
  from: eventSettingsEntityRef,
  carry: { pick: ["roleId", "gapMinutes", "idle"] },
  id: "roleId",
});

/** What one role is gathering for its next message. */
export const eventPending = liveCollection("supervisor-events.pending", {
  from: eventPendingEntityRef,
  carry: {
    pick: [
      "id",
      "roleId",
      "streamId",
      "key",
      "kind",
      "title",
      "ref",
      "count",
      "firstAt",
      "lastAt",
    ],
  },
  id: "id",
  all: {
    by: ["roleId"],
    orderBy: [["count", "desc"]],
    max: PENDING_PER_ROLE_MAX + 1,
  },
});

/** One role's recent messages, newest first. */
export const eventMessages = liveCollection("supervisor-events.messages", {
  from: eventMessagesEntityRef,
  carry: {
    pick: ["id", "roleId", "sentAt", "events", "lines", "outcome", "taskId"],
  },
  id: "id",
  all: {
    by: ["roleId"],
    orderBy: [["sentAt", "desc"]],
    max: MESSAGES_KEPT_PER_ROLE,
  },
});
