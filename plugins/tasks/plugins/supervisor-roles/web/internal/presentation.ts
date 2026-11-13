import { useMemo } from "react";
import {
  FieldPresentation,
  useLive,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  supervisorRoles,
  taskSupervisorShape,
  type SupervisorRole,
} from "../../core";

// Stable (module-level), so the mapped read changes only with the roles.
function toOptions(
  roles: readonly SupervisorRole[],
): readonly LiveFieldOption[] {
  return roles.map((r) => ({ value: r.id, label: r.name }));
}

/**
 * The `supervisor` field's options: every role, by name, read live. Loading
 * until the roles are known — never raw-id sections that relabel later.
 */
function useSupervisorOptions(): LiveFieldOptionsRead {
  const roles = useLive(supervisorRoles);
  return useMemo(() => mapResource(roles, toOptions), [roles]);
}

/**
 * The exposed `supervisor` field of every list whose rows reach a task: the
 * role that owns it, NULL (no row) the "None" bucket.
 */
export const supervisorPresentation = FieldPresentation.Register({
  owner: taskSupervisorShape.exposure,
  fields: { supervisor: { useOptions: useSupervisorOptions } },
});
