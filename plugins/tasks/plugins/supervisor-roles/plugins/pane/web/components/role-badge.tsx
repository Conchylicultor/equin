import type { ReactElement } from "react";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useTask } from "@plugins/tasks/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { taskSupervisors } from "@plugins/tasks/plugins/supervisor-roles/core";
import { useRoles } from "../internal/reads";
import { RoleIcon } from "./role-icon";

/**
 * A role named by id, as its pill (icon and name), read live. A role no
 * longer known (deleted since) keeps its raw id, so the pill never claims a
 * name it cannot read.
 */
export function SupervisorRoleBadge({
  roleId,
  tooltip,
  className,
}: {
  roleId: string;
  tooltip?: string;
  className?: string;
}): ReactElement {
  const roles = useRoles();
  if (roles.status === "loading")
    return <Loading variant="block" className="h-5 w-20" />;
  if (roles.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the supervisor roles"
        error={roles.error}
        refetch={roles.refetch}
      />
    );
  const role = roles.data.find((r) => r.id === roleId);
  return role ? (
    <Badge
      shape="pill"
      icon={<RoleIcon role={role} />}
      tooltip={tooltip}
      className={className}
    >
      {role.name}
    </Badge>
  ) : (
    <Badge shape="pill" mono tooltip={tooltip} className={className}>
      {roleId}
    </Badge>
  );
}

/**
 * A nested task's Supervisor value: the role owning its tree's root (an
 * adopted backlog task's own row is gone — the session root carries the
 * role), as a pill naming the root it comes from. Walks up the folder chain
 * one task read at a time; "None" when the root has no role.
 */
export function InheritedTaskSupervisor({
  folderId,
}: {
  folderId: string;
}): ReactElement {
  return <AncestorSupervisor taskId={folderId} />;
}

function AncestorSupervisor({ taskId }: { taskId: string }): ReactElement {
  const task = useTask(taskId);
  if (task.status === "loading")
    return <Loading variant="block" className="h-5 w-24" />;
  if (task.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the parent task"
        error={task.error}
        refetch={task.refetch}
      />
    );
  if (task.data === null) return <NoSupervisor />;
  if (task.data.folderId !== null)
    return <AncestorSupervisor taskId={task.data.folderId} />;
  return <RootSupervisor rootId={taskId} rootTitle={task.data.title} />;
}

function RootSupervisor({
  rootId,
  rootTitle,
}: {
  rootId: string;
  rootTitle: string;
}): ReactElement {
  const owner = useLive(taskSupervisors, { id: rootId });
  const openPane = useOpenPane();
  const result = mapRow(owner, (r) => r?.supervisor ?? null);
  if (result.status === "loading")
    return <Loading variant="block" className="h-5 w-24" />;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the supervisor"
        error={result.error}
        refetch={result.refetch}
      />
    );
  const roleId = result.data;
  if (roleId === null) return <NoSupervisor />;
  return (
    <Inline gap="sm">
      <SupervisorRoleBadge roleId={roleId} />
      <Text as="span" variant="caption" tone="muted">
        from{" "}
        <button
          type="button"
          {...openPane.link(
            taskDetailPane,
            { taskId: rootId },
            { mode: "swap" },
          )}
          className="hover:text-foreground underline underline-offset-2"
        >
          {rootTitle}
        </button>
      </Text>
    </Inline>
  );
}

function NoSupervisor(): ReactElement {
  return (
    <Text as="span" variant="caption" tone="muted">
      None
    </Text>
  );
}
