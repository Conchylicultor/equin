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
