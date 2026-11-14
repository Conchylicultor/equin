import { defineTriggerEvent } from "@plugins/infra/plugins/events/server";

export interface SupervisorRoleIconStalePayload {
  roleId: string;
  [key: string]: unknown;
}

/**
 * A role's auto icon no longer matches it: created, or its name or
 * description changed while its icon is Haiku's. The desktop picks a new one
 * (`machine/`); a host without a model hears nobody, and the role keeps the
 * icon it has (none at first).
 */
export const {
  event: supervisorRoleIconStale,
  table: _supervisorRoleIconStaleTriggers,
} = defineTriggerEvent<SupervisorRoleIconStalePayload>({
  name: "supervisorRoles.iconStale",
  filters: {},
});

export interface SupervisorRoleBacklogArrivedPayload {
  taskId: string;
  roleId: string;
  /** The agent whose filing it is, when one filed it (it never hears it). */
  actorConversationId: string | null;
  [key: string]: unknown;
}

/**
 * A task entered role `roleId`'s backlog: filed into it, or routed to it from
 * another role (or from none). The desktop tells the role's live session
 * (`machine/`, a watch source routed to the session's tree watch); with no
 * live session nobody hears it — the next session finds it in its backlog.
 */
export const {
  event: supervisorRoleBacklogArrived,
  table: _supervisorRoleBacklogArrivedTriggers,
} = defineTriggerEvent<SupervisorRoleBacklogArrivedPayload>({
  name: "supervisorRoles.backlogArrived",
  filters: {},
});
