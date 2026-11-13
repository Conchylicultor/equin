import { useMemo, type ReactElement } from "react";
import {
  DataView,
  defineDataView,
  defineItemActions,
  type FieldDef,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { rowOrStale } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useConversationById } from "@plugins/conversations/web";
import { usePatchTask, useTask } from "@plugins/tasks/web";
import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { adoptBacklogTask } from "@plugins/tasks/plugins/supervisor-roles/plugins/sessions/core";
import type { SupervisorRole } from "@plugins/tasks/plugins/supervisor-roles/core";
import { roleOfRow, type useRoleBacklog } from "../internal/reads";
import { isStale } from "../internal/format";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const BACKLOG_VIEW = defineDataView("tasks.supervisor-roles.backlog");

const youIcon = symbol("person");
const agentIcon = symbol("auto-awesome");
const dropIcon = symbol("delete");
const clearIcon = symbol("check-circle");

const BACKLOG_PLACE = { filedBy: "trail", age: "trail" } as const;
const NO_ROWS: TaskTreeRow[] = [];

/** A backlog row's actions: Adopt (the main verb) and Drop. */
const BacklogActions = defineItemActions<TaskTreeRow>();

function AdoptAction({
  row,
}: ItemActionProps<TaskTreeRow>): ReactElement | null {
  const fetchEndpoint = useFetchEndpoint();
  const roleId = roleOfRow(row);
  if (roleId === null) return null;
  return (
    <Button
      variant="outline"
      onClick={(e) => {
        e.stopPropagation();
        return fetchEndpoint(
          adoptBacklogTask,
          { id: roleId, taskId: row.id },
          { body: {} },
        );
      }}
    >
      Adopt
    </Button>
  );
}

function DropAction({ row }: ItemActionProps<TaskTreeRow>): ReactElement {
  const patchTask = usePatchTask();
  return (
    <IconButton
      icon={dropIcon}
      label="Drop"
      onClick={(e) => {
        e.stopPropagation();
        return patchTask(row.id, { drop: true });
      }}
    />
  );
}

/** The backlog's item actions, contributed by the plugin. */
export const backlogActions = [
  BacklogActions({ id: "adopt", component: AdoptAction }),
  BacklogActions({ id: "drop", component: DropAction }),
];
export { BacklogActions };

/**
 * The role's backlog: what agents (or a person) filed to it and no session
 * adopted yet, oldest first — Adopt moves a task into the live session
 * (launching one when none is live), Drop drops it.
 */
export function BacklogSection({
  role,
  backlog,
}: {
  role: SupervisorRole;
  backlog: ReturnType<typeof useRoleBacklog>;
}): ReactElement {
  const openPane = useOpenPane();
  const rows = foldResource(backlog, {
    loading: () => NO_ROWS,
    error: () => NO_ROWS,
    ready: (d) => d as TaskTreeRow[],
  });
  const fields = useMemo<FieldDef<TaskTreeRow>[]>(
    () => [
      {
        id: "title",
        label: "Task",
        type: "text",
        primary: true,
        value: (t) => t.title,
        sortable: true,
      },
      {
        id: "filedBy",
        label: "Filed by",
        type: "text",
        value: (t) => t.authorKind,
        cell: (t) => <FiledBy task={t} />,
        filterable: false,
      },
      {
        id: "age",
        label: "Age",
        type: "text",
        value: (t) => t.createdAt,
        cell: (t) => {
          const created = new Date(t.createdAt);
          return (
            <Text
              variant="caption"
              tone="muted"
              className={isStale(created) ? "text-warning" : undefined}
            >
              {formatRelativeTime(created, "short")}
            </Text>
          );
        },
        filterable: false,
        sortable: true,
      },
    ],
    [],
  );
  const oldest = rows[0];
  return (
    <DataView<TaskTreeRow>
      rows={rows}
      fields={fields}
      rowKey={(t) => t.id}
      views={["list"]}
      storageKey={BACKLOG_VIEW}
      readiness={backlog}
      title={
        <Inline gap="sm">
          <Text variant="label" tone="strong">
            Backlog
          </Text>
          <Text variant="count" tone="muted">
            {rows.length}
          </Text>
        </Inline>
      }
      actions={
        oldest ? (
          <Text
            variant="caption"
            className={
              isStale(new Date(oldest.createdAt))
                ? "text-warning"
                : "text-muted-foreground"
            }
            title="Age of the oldest task waiting"
          >
            {`Oldest ${formatRelativeTime(new Date(oldest.createdAt), "short")}`}
          </Text>
        ) : null
      }
      searchAccessor={(t) => t.title}
      searchPlaceholder={`Search ${role.name} backlog`}
      place={BACKLOG_PLACE}
      viewOptions={{ list: { actionsAtRest: true, columnCaptions: true } }}
      itemActions={BacklogActions}
      rowActivation={(t) =>
        openPane.to(taskDetailPane, { taskId: t.id }, { mode: "push" })
      }
      emptyState={<BacklogClear />}
    />
  );
}

function BacklogClear(): ReactElement {
  return (
    <Center axis="both">
      <Stack gap="xs" align="center">
        <Icon icon={clearIcon} className="size-5 text-success" />
        <Text variant="label">Backlog clear</Text>
      </Stack>
    </Center>
  );
}

/** Who filed a backlog task: You, or the task of the agent that filed it. */
function FiledBy({ task }: { task: TaskTreeRow }): ReactElement {
  if (task.authorKind !== "agent" || task.authorConversationId === null)
    return (
      <Inline gap="xs">
        <Icon icon={youIcon} className="size-3.5 text-muted-foreground" />
        <Text variant="caption" tone="muted">
          {task.authorKind === "human" ? "You" : "System"}
        </Text>
      </Inline>
    );
  return <AgentFiler conversationId={task.authorConversationId} />;
}

function AgentFiler({
  conversationId,
}: {
  conversationId: string;
}): ReactElement {
  const conversation = rowOrStale(useConversationById(conversationId));
  const filer = useTask(conversation?.taskId);
  const name =
    (filer.status === "ready" ? filer.data?.title : undefined) ??
    conversation?.title ??
    "An agent";
  return (
    <Inline gap="xs" title={`Filed by the agent in “${name}”`}>
      <Icon icon={agentIcon} className="size-3.5 text-muted-foreground" />
      <Text variant="caption" tone="muted">
        {name}
      </Text>
    </Inline>
  );
}
