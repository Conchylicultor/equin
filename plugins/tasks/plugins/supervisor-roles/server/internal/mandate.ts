import { MandateDefinitions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { supervisorPolicy } from "@plugins/tasks/plugins/mandate-presets/server";
import { supervisorRole, supervisorRoleMandate } from "../../core";

/**
 * A role session's mandate: the supervisor preset, computed at every
 * resolution (so a capability added to the preset reaches running sessions),
 * plus the role powers on the root.
 */
export const supervisorRoleDefinition = MandateDefinitions.Definition({
  mandate: supervisorRoleMandate,
  policy: () => supervisorPolicy({ root: [supervisorRole.grant(true)] }),
});
