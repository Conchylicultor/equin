import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  DataView,
  defineDataView,
  defineItemActions,
  type FieldDef,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import {
  combineResources,
  foldResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";
import {
  createSupervisorRole,
  type SupervisorRole,
} from "@plugins/tasks/plugins/supervisor-roles/core";
import {
  useAdhocSupervisors,
  useBacklogCounts,
  useLiveRoleSessions,
  useRoles,
} from "../internal/reads";
import { isStale, sessionLabel, useSessionNumbers } from "../internal/format";
import { RoleIcon } from "./role-icon";
import {
  LaunchSessionIconButton,
  OpenSessionIconButton,
} from "./session-actions";

// Markers scraped by codegen (data-views.generated.ts). Must live in web/**.
const ROLES_VIEW = defineDataView("tasks.supervisor-roles");
const ADHOC_VIEW = defineDataView("tasks.supervisor-roles.adhoc");

const addIcon = symbol("add");
const sharedIcon = symbol("stacks");
const adhocIcon = symbol("explore");
const unlistedIcon = symbol("visibility-off");

/** One role as the list draws it: the role, its live session, its backlog. */
export interface RoleRow {
  role: SupervisorRole;
  /** The live session's root, or `null` while the role is idle. */
  live: TaskTreeRow | null;
  /** Tasks waiting in its backlog. */
  backlog: number;
  /** When its oldest waiting task was filed, or `null` for none. */
  oldest: Date | null;
}

const NO_ROWS: RoleRow[] = [];
const NO_ADHOC: TaskTreeRow[] = [];

const ROLE_PLACE = {
  icon: "lead",
  state: "line2",
  backlog: "trail",
  oldest: "trail",
} as const;

const ADHOC_PLACE = {
  icon: "lead",
  state: "line2",
} as const;

/** The role rows' one main verb: Open the live session, else Launch one. */
export const RoleActions = defineItemActions<RoleRow>();

function SessionAction({ row }: ItemActionProps<RoleRow>): ReactElement {
  return row.live ? (
    <OpenSessionIconButton
      taskId={row.live.id}
      label={`Open ${row.role.name}'s session`}
    />
  ) : (
    <LaunchSessionIconButton roleId={row.role.id} />
  );
}

/** The ad-hoc rows' one verb: open the supervisor at work. */
export const AdhocActions = defineItemActions<TaskTreeRow>();

function OpenAdhocAction({ row }: ItemActionProps<TaskTreeRow>): ReactElement {
  return <OpenSessionIconButton taskId={row.id} label="Open session" />;
}

/** The pane's item actions, contributed by the plugin. */
export const supervisorsListActions = [
  RoleActions({ id: "session", component: SessionAction }),
  AdhocActions({ id: "open", component: OpenAdhocAction }),
];

/** The Supervisors pane's list: the shared prompt, the roles, the ad hoc. */
export function SupervisorsList({
  selected,
  linkToRole,
  linkToShared,
  onCreated,
}: {
  /** The open entry: a role id, `"all"` for the shared prompt, or none. */
  selected: string | undefined;
  linkToRole: (roleId: string) => LinkTarget;
  linkToShared: () => LinkTarget;
  /** A role was just created: open it, its name ready to type. */
  onCreated: (roleId: string) => void;
}): ReactElement {
  return (
    <Stack gap="lg">
      <SharedEntry selected={selected === "all"} linkToShared={linkToShared} />
      <RolesView
        selected={selected}
        linkToRole={linkToRole}
        onCreated={onCreated}
      />
      <AdhocView />
    </Stack>
  );
}

/**
 * The pinned "All supervisors" entry — not a record but the door to the one
 * prompt every supervisor shares, so a single Row ahead of the list.
 */
function SharedEntry({
  selected,
  linkToShared,
}: {
  selected: boolean;
  linkToShared: () => LinkTarget;
}): ReactElement {
  return (
    <Row
      selected={selected}
      icon={<Icon icon={sharedIcon} />}
      {...linkProps(linkToShared())}
    >
      <Stack gap="none">
        <Text variant="label">All supervisors</Text>
        <Text variant="caption" tone="muted">
          Shared prompt
        </Text>
      </Stack>
    </Row>
  );
}

function RolesView({
  selected,
  linkToRole,
  onCreated,
}: {
  selected: string | undefined;
  linkToRole: (roleId: string) => LinkTarget;
  onCreated: (roleId: string) => void;
}): ReactElement {
  const roles = useRoles();
  const counts = useBacklogCounts();
  const sessions = useLiveRoleSessions();
  const result = useMemo(
    () => combineResources({ roles, counts, sessions }),
    [roles, counts, sessions],
  );
  const rows = useMemo(
    () =>
      foldResource(result, {
        loading: () => NO_ROWS,
        error: () => NO_ROWS,
        ready: (d) =>
          d.roles.map((role) => ({
            role,
            live: d.sessions.get(role.id) ?? null,
            backlog: d.counts.byRole.get(role.id)?.count ?? 0,
            oldest: d.counts.byRole.get(role.id)?.oldest ?? null,
          })),
      }),
    [result],
  );
  const fetchEndpoint = useFetchEndpoint();
  const create = async () => {
    const { id } = await fetchEndpoint(
      createSupervisorRole,
      {},
      { body: { name: uniqueNewName(rows) } },
    );
    onCreated(id);
  };

  const fields = useMemo<FieldDef<RoleRow>[]>(
    () => [
      {
        id: "name",
        label: "Supervisor",
        type: "text",
        primary: true,
        value: (r) => r.role.name,
        cell: (r) => <RoleName role={r.role} />,
        sortable: true,
      },
      {
        id: "icon",
        label: "Icon",
        type: "text",
        value: (r) => r.role.id,
        cell: (r) => <RoleIcon role={r.role} />,
        filterable: false,
      },
      {
        id: "state",
        label: "Session",
        type: "text",
        value: (r) => (r.live ? "Live" : "Idle"),
        cell: (r) => <SessionState row={r} />,
      },
      {
        id: "backlog",
        label: "Backlog",
        type: "number",
        value: (r) => r.backlog,
        cell: (r) => (
          <Text variant="count" tone={r.backlog === 0 ? "faint" : "default"}>
            {r.backlog === 0 ? "—" : r.backlog}
          </Text>
        ),
        sortable: true,
      },
      {
        id: "oldest",
        label: "Oldest waiting",
        type: "text",
        value: (r) => r.role.id,
        cell: (r) =>
          r.oldest === null ? null : <OldestAge oldest={r.oldest} />,
        filterable: false,
      },
      {
        id: "description",
        label: "Description agents get",
        type: "text",
        value: (r) => r.role.description,
        visible: false,
      },
    ],
    [],
  );

  return (
    <DataView<RoleRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.role.id}
      views={["list"]}
      storageKey={ROLES_VIEW}
      readiness={result}
      selectedRowId={selected}
      rowActivation={(r) => linkToRole(r.role.id)}
      searchAccessor={(r) => `${r.role.name} ${r.role.description}`}
      searchPlaceholder="Search supervisors"
      place={ROLE_PLACE}
      viewOptions={{ list: { actionsAtRest: true, columnCaptions: true } }}
      itemActions={RoleActions}
      actions={
        <IconButton icon={addIcon} label="New supervisor" onClick={create} />
      }
      emptyState={<>No supervisor yet.</>}
    />
  );
}

/** "New supervisor", or "New supervisor 2"… — names are unique. */
function uniqueNewName(rows: readonly RoleRow[]): string {
  const taken = new Set(rows.map((r) => r.role.name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "New supervisor" : `New supervisor ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

function RoleName({ role }: { role: SupervisorRole }): ReactElement {
  return (
    <Inline gap="xs">
      <Text variant="label">{role.name}</Text>
      {role.listed ? null : (
        <Icon
          icon={unlistedIcon}
          className="size-3 text-muted-foreground"
          aria-label="Not listed to agents"
        />
      )}
    </Inline>
  );
}

function SessionState({ row }: { row: RoleRow }): ReactElement {
  const numbers = useSessionNumbers(row.role.id);
  if (!row.live)
    return (
      <Text variant="caption" tone="muted">
        Idle
      </Text>
    );
  return (
    <Inline gap="xs">
      <StatusDot colorClass="bg-success" />
      <Text variant="caption" className="text-success">
        {sessionLabel(numbers, row.live)}
      </Text>
    </Inline>
  );
}

/** How long the oldest task of a role's backlog has waited. */
function OldestAge({ oldest: created }: { oldest: Date }): ReactElement {
  return (
    <Text
      variant="caption"
      tone="muted"
      className={isStale(created) ? "text-warning" : undefined}
      title={`Oldest waiting ${formatRelativeTime(created)}`}
    >
      {formatRelativeTime(created, "short")}
    </Text>
  );
}

/** The ad-hoc supervisors: launched with the Supervisor option, no backlog. */
function AdhocView(): ReactElement | null {
  const adhoc = useAdhocSupervisors();
  const rows = foldResource(adhoc, {
    loading: () => NO_ADHOC,
    error: () => NO_ADHOC,
    ready: (d) => d as TaskTreeRow[],
  });
  const fields = useMemo<FieldDef<TaskTreeRow>[]>(
    () => [
      {
        id: "title",
        label: "Supervisor",
        type: "text",
        primary: true,
        value: (r) => r.title,
        sortable: true,
      },
      {
        id: "icon",
        label: "Icon",
        type: "text",
        value: (r) => r.id,
        cell: () => <Icon icon={adhocIcon} />,
        filterable: false,
      },
      {
        id: "state",
        label: "Live since",
        type: "text",
        value: (r) => r.createdAt,
        cell: (r) => (
          <Inline gap="xs">
            <StatusDot colorClass="bg-success" />
            <Text variant="caption" className="text-success">
              {`Live ${formatRelativeTime(new Date(r.createdAt), "short")}`}
            </Text>
          </Inline>
        ),
        filterable: false,
      },
    ],
    [],
  );
  // Nothing ad hoc running: no section at all (it is not a list a person
  // fills — it appears while one runs).
  if (adhoc.status === "ready" && adhoc.data.length === 0) return null;
  return (
    <DataView<TaskTreeRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.id}
      views={["list"]}
      storageKey={ADHOC_VIEW}
      readiness={adhoc}
      place={ADHOC_PLACE}
      viewOptions={{ list: { actionsAtRest: true, columnCaptions: false } }}
      itemActions={AdhocActions}
      emptyState={<>No ad-hoc supervisor is running.</>}
    />
  );
}
