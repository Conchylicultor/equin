import { useState, type ReactElement } from "react";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  ResourceErrorInline,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { taskMandates } from "@plugins/tasks/plugins/tasks-core/core";
import {
  setTaskSupervisor,
  supervisorRoleMandate,
  taskSupervisors,
  type SupervisorRole,
} from "@plugins/tasks/plugins/supervisor-roles/core";
import {
  useBacklogCounts,
  useLiveRoleSessions,
  useRoles,
} from "../internal/reads";
import { RoleIcon } from "./role-icon";

const chevronIcon = symbol("expand-more");
const unlistedIcon = symbol("visibility-off");
const checkIcon = symbol("check");

/**
 * A role as a pill: its icon and name — the task header's Supervisor value
 * and the task list's Supervisor cell alike.
 */
export function SupervisorPill({
  role,
}: {
  role: Pick<SupervisorRole, "icon" | "name">;
}): ReactElement {
  return (
    <Badge shape="pill" icon={<RoleIcon role={role} />}>
      {role.name}
    </Badge>
  );
}

/**
 * The task detail's Supervisor value: the role that owns the task, as a pill
 * that re-routes it — picking another role moves the task to that role's
 * backlog. A session's root keeps its role (the session works for it), so
 * there it is the pill alone.
 */
export function TaskSupervisorControl({
  taskId,
}: {
  taskId: string;
}): ReactElement | null {
  const owner = useLive(taskSupervisors, { id: taskId });
  const mandate = useLive(taskMandates, { id: taskId });
  const roles = useRoles();
  const counts = useBacklogCounts();
  const live = useLiveRoleSessions();
  const result = combineResources({
    owner: mapRow(owner, (r) => r?.supervisor ?? null),
    sessionRoot: mapRow(
      mandate,
      (m) =>
        m != null &&
        m.mandateId === supervisorRoleMandate.id &&
        m.sourceTaskId === taskId,
    ),
    roles,
    counts,
    live,
  });
  const [open, setOpen] = useState(false);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();

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
  const { owner: ownerId, sessionRoot, roles: all } = result.data;
  const current = all.find((r) => r.id === ownerId) ?? null;
  if (sessionRoot && current) return <SupervisorPill role={current} />;

  const route = async (roleId: string) => {
    setOpen(false);
    if (roleId === ownerId) return;
    try {
      await fetchEndpoint(
        setTaskSupervisor,
        { taskId },
        { body: { supervisor: roleId } },
      );
    } catch (err) {
      toast({
        type: "task",
        category: "other",
        title: "Failed to re-route the task",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
      return;
    }
    const to = all.find((r) => r.id === roleId);
    toast({
      type: "task",
      category: "other",
      title: `Moved to the ${to?.name ?? roleId} backlog`,
      description: "",
      variant: "success",
    });
  };

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      label="Supervisor"
      side="bottom"
      align="start"
      trigger={
        <Button variant="outline" shape="pill" aria-label="Supervisor">
          {current ? (
            <>
              <RoleIcon role={current} className="size-3.5" />
              {current.name}
            </>
          ) : (
            <Text as="span" tone="muted">
              None
            </Text>
          )}
          <Icon icon={chevronIcon} />
        </Button>
      }
    >
      <ControlPanel.Section>
        {all.map((r) => (
          <ControlPanel.Row
            key={r.id}
            icon={<RoleIcon role={r} />}
            selected={r.id === ownerId}
            onSelect={() => void route(r.id)}
            trailing={
              r.id === ownerId ? (
                <Icon icon={checkIcon} />
              ) : (
                <Text variant="count" tone="muted">
                  {result.data.counts.byRole.get(r.id)?.count ?? 0}
                </Text>
              )
            }
            description={r.description.trim() === "" ? " " : r.description}
          >
            <Inline gap="xs">
              {r.name}
              {result.data.live.has(r.id) ? (
                <StatusDot colorClass="bg-success" />
              ) : null}
              {r.listed ? null : (
                <Icon
                  icon={unlistedIcon}
                  className="size-3 text-muted-foreground"
                  aria-label="Not listed to agents"
                />
              )}
            </Inline>
          </ControlPanel.Row>
        ))}
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}
