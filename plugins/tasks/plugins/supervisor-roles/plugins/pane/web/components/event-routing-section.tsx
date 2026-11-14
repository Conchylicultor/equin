import { useMemo, useState, type ReactElement } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { runtimeSymbol, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { SupervisorRole } from "@plugins/tasks/plugins/supervisor-roles/core";
import {
  eventRoutes,
  eventStreams,
  routeEventStream,
  type EventRoute,
  type EventStreamInfo,
} from "@plugins/tasks/plugins/supervisor-roles/plugins/events/core";
import { useRoles } from "../internal/reads";
import { RoleIcon } from "./role-icon";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const ROUTING_VIEW = defineDataView("tasks.supervisor-roles.event-routing");

const nobodyIcon = symbol("notifications-off");
const chevronIcon = symbol("keyboard-arrow-down");

interface RoutingRow {
  stream: EventStreamInfo;
  route: EventRoute | null;
}

const ROUTING_PLACE = { sentTo: "trail" } as const;

/**
 * Where every event stream goes, in one place: each stream to one supervisor,
 * or to nobody. The same routes a role's Events section edits.
 */
export function EventRoutingSection(): ReactElement {
  const all = combineResources({
    streams: useLive(eventStreams),
    routes: useLive(eventRoutes),
    roles: useRoles(),
  });
  return foldResource(all, {
    loading: () => <Loading variant="rows" />,
    error: (err) => <Placeholder tone="error">{err.message}</Placeholder>,
    ready: (d) => (
      <RoutingView
        rows={d.streams.map((s) => ({
          stream: s,
          route: d.routes.find((r) => r.streamId === s.id) ?? null,
        }))}
        roles={d.roles}
      />
    ),
  });
}

function RoutingView({
  rows,
  roles,
}: {
  rows: RoutingRow[];
  roles: readonly SupervisorRole[];
}): ReactElement {
  const fields = useMemo<FieldDef<RoutingRow>[]>(
    () => [
      {
        id: "stream",
        label: "Stream",
        type: "text",
        primary: true,
        value: (r) => r.stream.label,
        cell: (r) => (
          <Inline gap="sm">
            <Icon
              icon={runtimeSymbol(r.stream.icon)}
              className={`size-4 text-muted-foreground ${rigidClass()}`}
            />
            <Stack gap="none">
              <Text variant="body">{r.stream.label}</Text>
              <Text variant="caption" tone="muted">
                {r.stream.description}
              </Text>
            </Stack>
          </Inline>
        ),
      },
      {
        id: "sentTo",
        label: "Sent to",
        type: "text",
        value: (r) =>
          roles.find((x) => x.id === r.route?.roleId)?.name ?? "Nobody",
        cell: (r) => <RouteSelect row={r} roles={roles} />,
      },
    ],
    [roles],
  );
  return (
    <DataView<RoutingRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.stream.id}
      views={["list"]}
      storageKey={ROUTING_VIEW}
      title={
        <Text variant="label" tone="strong">
          Event routing
        </Text>
      }
      searchAccessor={(r) => r.stream.label}
      searchPlaceholder="Search streams"
      place={ROUTING_PLACE}
      viewOptions={{ list: { actionsAtRest: true, columnCaptions: true } }}
      emptyState={
        <Text variant="caption" tone="muted">
          No event streams
        </Text>
      }
    />
  );
}

function RouteSelect({
  row,
  roles,
}: {
  row: RoutingRow;
  roles: readonly SupervisorRole[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const fetchEndpoint = useFetchEndpoint();
  const owner = roles.find((x) => x.id === row.route?.roleId) ?? null;
  const pick = (roleId: string | null) => {
    setOpen(false);
    return fetchEndpoint(
      routeEventStream,
      { streamId: row.stream.id },
      // A stream moving to another role starts unfiltered there.
      {
        body: {
          roleId,
          kinds: roleId === owner?.id ? (row.route?.kinds ?? null) : null,
        },
      },
    );
  };
  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      label={`Send ${row.stream.label} to`}
      side="bottom"
      align="end"
      trigger={
        <Button variant="outline" onClick={(e) => e.stopPropagation()}>
          {owner ? (
            <RoleIcon role={owner} className="size-4" />
          ) : (
            <Icon icon={nobodyIcon} />
          )}
          {owner?.name ?? "Nobody"}
          <Icon icon={chevronIcon} />
        </Button>
      }
    >
      <ControlPanel.Section>
        {roles.map((r) => (
          <ControlPanel.Row
            key={r.id}
            select="radio"
            indicator="trailing"
            checked={owner?.id === r.id}
            icon={<RoleIcon role={r} className="size-4" />}
            onSelect={() => pick(r.id)}
          >
            {r.name}
          </ControlPanel.Row>
        ))}
        <ControlPanel.Row
          select="radio"
          indicator="trailing"
          checked={owner === null}
          icon={<Icon icon={nobodyIcon} />}
          description="No session is told"
          onSelect={() => pick(null)}
        >
          Nobody
        </ControlPanel.Row>
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}
