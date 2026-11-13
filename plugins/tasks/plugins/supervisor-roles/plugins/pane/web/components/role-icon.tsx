import type { ReactElement } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { runtimeSymbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { SupervisorRole } from "@plugins/tasks/plugins/supervisor-roles/core";

/** A role's glyph, or `null` while its icon is still being picked. */
export function roleIconRef(
  role: Pick<SupervisorRole, "icon">,
): IconRef | null {
  return role.icon === null ? null : runtimeSymbol(role.icon);
}

/**
 * A role's icon: its glyph, or a shimmer while Haiku has not picked one yet
 * (a new role, a host whose model has not answered).
 */
export function RoleIcon({
  role,
  className,
}: {
  role: Pick<SupervisorRole, "icon">;
  className?: string;
}): ReactElement {
  const icon = roleIconRef(role);
  return icon === null ? (
    <Loading variant="block" className={className ?? "size-4"} />
  ) : (
    <Icon icon={icon} className={className} />
  );
}
