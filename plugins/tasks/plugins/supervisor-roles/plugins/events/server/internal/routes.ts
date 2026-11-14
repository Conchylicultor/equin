import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { getSupervisorRole } from "@plugins/tasks/plugins/supervisor-roles/server";
import {
  DEFAULT_GAP_MINUTES,
  DEFAULT_IDLE_POLICY,
  routeEventStream,
  updateEventSettings,
} from "../../core";
import { streamSpec } from "./streams";
import { _supervisorEventRoutes, _supervisorEventSettings } from "./tables";

async function assertRole(id: string): Promise<void> {
  if (!(await getSupervisorRole(id)))
    throw new HttpError(404, `No supervisor role "${id}".`);
}

export const handleRouteEventStream = implement(
  routeEventStream,
  async ({ params, body }) => {
    const stream = streamSpec(params.streamId);
    if (!stream)
      throw new HttpError(404, `No event stream "${params.streamId}".`);
    if (body.roleId === null) {
      await db
        .delete(_supervisorEventRoutes)
        .where(eq(_supervisorEventRoutes.streamId, stream.id));
      return;
    }
    await assertRole(body.roleId);
    const known = new Set(stream.kinds());
    const unknown = body.kinds?.find((k) => !known.has(k));
    if (unknown !== undefined)
      throw new HttpError(400, `${stream.label} has no kind "${unknown}".`);
    const row = { roleId: body.roleId, kinds: body.kinds };
    await db
      .insert(_supervisorEventRoutes)
      .values({ streamId: stream.id, ...row })
      .onConflictDoUpdate({
        target: _supervisorEventRoutes.streamId,
        set: row,
      });
  },
);

export const handleUpdateEventSettings = implement(
  updateEventSettings,
  async ({ params, body }) => {
    await assertRole(params.id);
    const set = {
      ...(body.gapMinutes !== undefined ? { gapMinutes: body.gapMinutes } : {}),
      ...(body.idle !== undefined ? { idle: body.idle } : {}),
    };
    await db
      .insert(_supervisorEventSettings)
      .values({
        roleId: params.id,
        gapMinutes: DEFAULT_GAP_MINUTES,
        idle: DEFAULT_IDLE_POLICY,
        ...set,
      })
      .onConflictDoUpdate({
        target: _supervisorEventSettings.roleId,
        // An empty patch still needs a SET: rewrite the key.
        set: { roleId: params.id, ...set },
      });
  },
);
