import { MandateDefinitions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { supervisorPolicy } from "@plugins/tasks/plugins/mandate-presets/server";
import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { supervisorRole, supervisorRoleMandate } from "../../core";

/**
 * A role session's mandate: the supervisor preset, computed at every
 * resolution (so a capability added to the preset reaches running sessions),
 * plus the role powers on the root.
 *
 * OWNED: a root stating it is a session of the role its `supervisor` row
 * names, so only the launch states it (with that row, in one transaction).
 * Nobody states it by hand, and a task re-filed out of a session's tree to the
 * root states the interactive mandate — it leaves the session, and the role
 * with it (a person can route it back to a backlog with the Supervisor pill).
 */
export const supervisorRoleDefinition = MandateDefinitions.Definition({
  mandate: supervisorRoleMandate,
  policy: () => supervisorPolicy({ root: [supervisorRole.grant(true)] }),
  owned: { refiledAs: interactiveMandate },
});
