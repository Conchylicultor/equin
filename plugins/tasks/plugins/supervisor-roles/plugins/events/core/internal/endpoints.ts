import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { GAP_MINUTES_MAX, IDLE_POLICIES, ROUTE_KINDS_MAX } from "./entities";

export const RouteEventStreamBodySchema = z.object({
  /** The role the stream goes to from now on (taken from any other); null: nobody. */
  roleId: z.string().min(1).nullable(),
  /** Only these of the stream's kinds; null: all of them. */
  kinds: cappedList(z.string(), { max: ROUTE_KINDS_MAX }).nullable(),
});
export type RouteEventStreamBody = z.infer<typeof RouteEventStreamBodySchema>;

/** Send a stream to a role (one role per stream), or to nobody. */
export const routeEventStream = defineEndpoint({
  route: "PUT /api/supervisor-events/streams/:streamId",
  body: RouteEventStreamBodySchema,
});

export const UpdateEventSettingsBodySchema = z.object({
  gapMinutes: z.number().int().min(1).max(GAP_MINUTES_MAX).optional(),
  idle: z.enum(IDLE_POLICIES).optional(),
});
export type UpdateEventSettingsBody = z.infer<
  typeof UpdateEventSettingsBodySchema
>;

/** Edit a role's event settings. */
export const updateEventSettings = defineEndpoint({
  route: "PATCH /api/supervisor-roles/:id/events",
  body: UpdateEventSettingsBodySchema,
});

/** Send what a role is gathering now, without waiting for its quiet period to end. */
export const flushRoleEvents = defineEndpoint({
  route: "POST /api/supervisor-roles/:id/events/flush",
  needsMachine: { feature: "Sending a supervisor its events" },
});
