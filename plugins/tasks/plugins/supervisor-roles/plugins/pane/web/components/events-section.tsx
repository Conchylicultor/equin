import { useMemo, useState, type ReactElement } from "react";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
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
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { runtimeSymbol, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { SupervisorRole } from "@plugins/tasks/plugins/supervisor-roles/core";
import {
  DEFAULT_GAP_MINUTES,
  DEFAULT_IDLE_POLICY,
  GAP_MINUTES_MAX,
  eventMessages,
  eventPending,
  eventRoutes,
  eventSettings,
  eventStreams,
  flushRoleEvents,
  nextMessageAt,
  routeEventStream,
  updateEventSettings,
  type EventLine,
  type EventRoute,
  type EventStreamInfo,
  type IdlePolicy,
  type MessageOutcome,
  type UpdateEventSettingsBody,
} from "@plugins/tasks/plugins/supervisor-roles/plugins/events/core";
import { useRoles } from "../internal/reads";
import { SettingRow } from "./setting-row";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MESSAGES_VIEW = defineDataView("tasks.supervisor-roles.event-messages");

const addIcon = symbol("add");
const removeIcon = symbol("close");
const minusIcon = symbol("remove");
const filterIcon = symbol("filter-list");
const sendIcon = symbol("send");
const stormIcon = symbol("thunderstorm");

const IDLE_OPTIONS = [
  {
    id: "drop",
    label: "Drop",
    tooltip: "Nothing is sent; the reports stay where they are",
  },
  {
    id: "backlog",
    label: "File in backlog",
    tooltip: "One backlog task per message",
  },
  {
    id: "launch",
    label: "Launch a session",
    tooltip: "Launch a session briefed with the message",
  },
] as const satisfies readonly {
  id: IdlePolicy;
  label: string;
  tooltip: string;
}[];

const OUTCOME: Record<
  MessageOutcome | "gathering",
  { label: string; variant: BadgeVariant }
> = {
  gathering: { label: "Gathering", variant: "warning" },
  sent: { label: "Sent", variant: "success" },
  dropped: { label: "Dropped", variant: "muted" },
  filed: { label: "Filed in backlog", variant: "info" },
  launched: { label: "Launched a session", variant: "info" },
};

/** A row of the message log: a message sent, or the one being gathered. */
interface MessageRow {
  id: string;
  at: Date;
  events: number;
  lines: readonly EventLine[];
  outcome: MessageOutcome | "gathering";
}

const NO_ROWS: MessageRow[] = [];

const clock = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * A role's events: the streams sent to it (each narrowed to some kinds), how
 * its messages are spaced and what happens with no live session, what it is
 * gathering for the next message (Send now), and its recent messages.
 */
export function EventsSection({
  role,
}: {
  role: SupervisorRole;
}): ReactElement {
  // The role's settings row: none is the defaults.
  const settingsRead = useLive(eventSettings, { id: role.id });
  const all = combineResources({
    streams: useLive(eventStreams),
    routes: useLive(eventRoutes),
    pending: useLive(eventPending, { where: { roleId: role.id } }),
    messages: useLive(eventMessages, { where: { roleId: role.id } }),
  });
  if (settingsRead.status === "loading")
    return <Loading variant="block" className="h-24 w-full" />;
  if (settingsRead.status === "error")
    return <Placeholder tone="error">{settingsRead.error.message}</Placeholder>;
  const settings = settingsRead.found ? settingsRead.row : null;
  return foldResource(all, {
    loading: () => <Loading variant="block" className="h-24 w-full" />,
    error: (err) => <Placeholder tone="error">{err.message}</Placeholder>,
    ready: (d) => (
      <EventsBody
        role={role}
        streams={d.streams}
        routes={d.routes}
        gapMinutes={settings?.gapMinutes ?? DEFAULT_GAP_MINUTES}
        idle={settings?.idle ?? DEFAULT_IDLE_POLICY}
        pending={d.pending.map((p) => ({
          streamId: p.streamId,
          kind: p.kind,
          title: p.title,
          ref: p.ref,
          count: p.count,
        }))}
        messages={d.messages.map((m) => ({
          id: m.id,
          at: new Date(m.sentAt),
          events: m.events,
          lines: m.lines,
          outcome: m.outcome,
        }))}
      />
    ),
  });
}

function EventsBody({
  role,
  streams,
  routes,
  gapMinutes,
  idle,
  pending,
  messages,
}: {
  role: SupervisorRole;
  streams: readonly EventStreamInfo[];
  routes: readonly EventRoute[];
  gapMinutes: number;
  idle: IdlePolicy;
  pending: EventLine[];
  messages: MessageRow[];
}): ReactElement {
  const fetchEndpoint = useFetchEndpoint();
  const canSend = useMachineAvailability(flushRoleEvents).available;
  const mine = routes.filter((r) => r.roleId === role.id);
  const streamOf = (id: string) => streams.find((s) => s.id === id);
  const save = (body: UpdateEventSettingsBody) =>
    fetchEndpoint(updateEventSettings, { id: role.id }, { body });
  const route = (
    streamId: string,
    kinds: string[] | null,
    roleId: string | null,
  ) =>
    fetchEndpoint(routeEventStream, { streamId }, { body: { roleId, kinds } });

  const waiting = pending.reduce((n, l) => n + l.count, 0);
  const last = messages[0]?.at ?? null;
  const next = nextMessageAt(last, gapMinutes * 60_000, new Date());
  const rows = useMemo<MessageRow[]>(
    () =>
      waiting === 0
        ? messages
        : [
            {
              id: "gathering",
              at: next,
              events: waiting,
              lines: pending,
              outcome: "gathering",
            },
            ...messages,
          ],
    [messages, pending, waiting, next],
  );
  const has = mine.length > 0;

  return (
    <Stack gap="sm">
      <Stack direction="row" gap="sm" align="center">
        <Text variant="label" tone="strong">
          Events
        </Text>
        {has ? (
          <Text variant="count" tone="muted">
            {mine.length}
          </Text>
        ) : null}
        <Fill />
        {has && waiting > 0 ? (
          <Text variant="caption" tone="muted">
            {`Next message at ${clock(next)} · ${waiting} waiting`}
          </Text>
        ) : null}
      </Stack>

      {waiting > 0 ? (
        <Card padding="sm" className="border-warning/40 bg-warning/5">
          <Stack direction="row" gap="md" align="center">
            <Icon
              icon={stormIcon}
              className={`size-5 text-warning ${rigidClass()}`}
            />
            <Fill>
              <Stack gap="none">
                <Text variant="label">{`${waiting} ${waiting === 1 ? "event" : "events"} gathering`}</Text>
                <Text variant="caption" tone="muted">
                  {`Sent as one message at ${clock(next)}${pending.length > 1 && pending[0] ? ` · the most frequent: ${pending[0].kind} · ${pending[0].title}` : ""}`}
                </Text>
              </Stack>
            </Fill>
            {canSend ? (
              <Button
                variant="outline"
                onClick={() =>
                  fetchEndpoint(flushRoleEvents, { id: role.id }, {})
                }
              >
                <Icon icon={sendIcon} />
                Send now
              </Button>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      <Card padding="none">
        {mine.map((r) => {
          const s = streamOf(r.streamId);
          return s ? (
            <StreamRow
              key={r.streamId}
              stream={s}
              kinds={r.kinds}
              onKinds={(kinds) => route(s.id, kinds, role.id)}
              onRemove={() => route(s.id, null, null)}
            />
          ) : null;
        })}
        {has ? null : (
          <Text variant="caption" tone="muted" className="block px-md pt-md">
            No events — this supervisor only sees its backlog
          </Text>
        )}
        <AddStream
          role={role}
          streams={streams.filter(
            (s) => !mine.some((r) => r.streamId === s.id),
          )}
          routes={routes}
          onAdd={(s) => route(s.id, null, role.id)}
        />
        {has ? (
          <>
            <SettingRow label="Space messages">
              <Stack direction="row" gap="sm" align="center">
                <Inline gap="2xs">
                  <IconButton
                    icon={minusIcon}
                    label="Shorter"
                    disabled={gapMinutes <= 1}
                    onClick={() =>
                      save({
                        gapMinutes: Math.max(
                          1,
                          gapMinutes - 5 <= 0 ? 1 : gapMinutes - 5,
                        ),
                      })
                    }
                  />
                  <Text
                    variant="label"
                    className="min-w-8 text-center tabular-nums"
                  >
                    {gapMinutes}
                  </Text>
                  <IconButton
                    icon={addIcon}
                    label="Longer"
                    disabled={gapMinutes >= GAP_MINUTES_MAX}
                    onClick={() =>
                      save({
                        gapMinutes: Math.min(
                          GAP_MINUTES_MAX,
                          gapMinutes < 5 ? 5 : gapMinutes + 5,
                        ),
                      })
                    }
                  />
                </Inline>
                <Text variant="caption" tone="muted">
                  min — the first event goes at once; what follows gathers into
                  one message
                </Text>
              </Stack>
            </SettingRow>
            <SettingRow label="No live session">
              <SegmentedControl
                options={IDLE_OPTIONS}
                value={idle}
                onChange={(v) => void save({ idle: v })}
                variant="ghost"
                label="No live session"
              />
            </SettingRow>
          </>
        ) : null}
      </Card>

      {has || rows.length > 0 ? <MessagesView rows={rows} /> : null}
    </Stack>
  );
}

function StreamRow({
  stream,
  kinds,
  onKinds,
  onRemove,
}: {
  stream: EventStreamInfo;
  kinds: readonly string[] | null;
  onKinds: (kinds: string[] | null) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}): ReactElement {
  return (
    <Stack direction="row" gap="md" align="center" className="border-b p-md">
      <Icon
        icon={runtimeSymbol(stream.icon)}
        className={`size-5 text-muted-foreground ${rigidClass()}`}
      />
      <Fill>
        <Stack gap="none">
          <Text variant="label">{stream.label}</Text>
          <Text variant="caption" tone="muted">
            {stream.description}
          </Text>
        </Stack>
      </Fill>
      <KindsPick stream={stream} kinds={kinds} onChange={onKinds} />
      <IconButton
        icon={removeIcon}
        label="Stop sending this stream"
        onClick={onRemove}
      />
    </Stack>
  );
}

function KindsPick({
  stream,
  kinds,
  onChange,
}: {
  stream: EventStreamInfo;
  kinds: readonly string[] | null;
  onChange: (kinds: string[] | null) => Promise<unknown>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const on = kinds ?? stream.kinds;
  const toggle = (k: string) => {
    const next = on.includes(k) ? on.filter((x) => x !== k) : [...on, k];
    return onChange(next.length === stream.kinds.length ? null : next);
  };
  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      label={`Kinds of ${stream.label}`}
      side="bottom"
      align="end"
      trigger={
        <Button variant="outline">
          <Icon icon={filterIcon} />
          {kinds === null
            ? `All ${stream.kinds.length} kinds`
            : `${kinds.length} of ${stream.kinds.length} kinds`}
        </Button>
      }
    >
      <ControlPanel.Section>
        <ControlPanel.Row
          select="check"
          checked={kinds === null}
          onSelect={() => onChange(null)}
        >
          All kinds
        </ControlPanel.Row>
      </ControlPanel.Section>
      <ControlPanel.Section>
        {stream.kinds.map((k) => (
          <ControlPanel.Row
            key={k}
            select="check"
            checked={on.includes(k)}
            onSelect={() => toggle(k)}
          >
            {k}
          </ControlPanel.Row>
        ))}
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}

function AddStream({
  role,
  streams,
  routes,
  onAdd,
}: {
  role: SupervisorRole;
  streams: readonly EventStreamInfo[];
  routes: readonly EventRoute[];
  onAdd: (s: EventStreamInfo) => Promise<unknown>;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const roles = useRoles();
  if (streams.length === 0) return null;
  const nameOf = (id: string) =>
    roles.status === "ready"
      ? (roles.data.find((r) => r.id === id)?.name ?? null)
      : null;
  return (
    <div className="p-xs">
      <ControlPanelPopover
        open={open}
        onOpenChange={setOpen}
        label={`Add a stream to ${role.name}`}
        side="bottom"
        align="start"
        trigger={
          <Button variant="ghost">
            <Icon icon={addIcon} />
            Add a stream
          </Button>
        }
      >
        <ControlPanel.Section>
          {streams.map((s) => {
            const owner = routes.find((r) => r.streamId === s.id);
            const from = owner ? nameOf(owner.roleId) : null;
            return (
              <ControlPanel.Row
                key={s.id}
                icon={<Icon icon={runtimeSymbol(s.icon)} />}
                description={
                  from === null
                    ? s.description
                    : `Sent to ${from} today — adding it here moves it`
                }
                onSelect={() => {
                  setOpen(false);
                  return onAdd(s);
                }}
              >
                {s.label}
              </ControlPanel.Row>
            );
          })}
        </ControlPanel.Section>
      </ControlPanelPopover>
    </div>
  );
}

const MESSAGE_PLACE = { events: "trail", outcome: "trail" } as const;

/** The role's messages, newest first — the one being gathered on top. */
function MessagesView({ rows }: { rows: MessageRow[] }): ReactElement {
  const fields = useMemo<FieldDef<MessageRow>[]>(
    () => [
      {
        id: "message",
        label: "Message",
        type: "text",
        primary: true,
        value: (m) => m.lines.map((l) => `${l.kind} ${l.title}`).join(" "),
        cell: (m) => <MessageCell row={m} />,
      },
      {
        id: "events",
        label: "Events",
        type: "text",
        value: (m) => String(m.events),
        cell: (m) => (
          <Text variant="caption" tone="muted" className="tabular-nums">
            {m.events}
          </Text>
        ),
        filterable: false,
      },
      {
        id: "outcome",
        label: "Outcome",
        type: "text",
        value: (m) => m.outcome,
        cell: (m) => (
          <Badge variant={OUTCOME[m.outcome].variant}>
            {OUTCOME[m.outcome].label}
          </Badge>
        ),
      },
    ],
    [],
  );
  return (
    <DataView<MessageRow>
      rows={rows.length > 0 ? rows : NO_ROWS}
      fields={fields}
      rowKey={(m) => m.id}
      views={["list"]}
      storageKey={MESSAGES_VIEW}
      title={
        <Text variant="label" tone="strong">
          Messages
        </Text>
      }
      searchAccessor={(m) =>
        m.lines.map((l) => `${l.kind} ${l.title}`).join(" ")
      }
      searchPlaceholder="Search messages"
      place={MESSAGE_PLACE}
      viewOptions={{ list: { columnCaptions: true } }}
      emptyState={
        <Text variant="caption" tone="muted">
          No messages yet
        </Text>
      }
    />
  );
}

/** A message's lead line, the rest of its lines in the tooltip. */
function MessageCell({ row }: { row: MessageRow }): ReactElement {
  const [first, ...rest] = row.lines;
  return (
    <Inline
      gap="sm"
      title={row.lines
        .map((l) => `×${l.count} ${l.kind} · ${l.title}`)
        .join("\n")}
    >
      <Text
        variant="caption"
        tone="muted"
        className={`font-mono ${rigidClass()}`}
      >
        {first?.kind ?? ""}
      </Text>
      <Text variant="body">{first?.title ?? ""}</Text>
      {rest.length > 0 ? (
        <Text variant="caption" tone="muted" className={rigidClass()}>
          {`+${rest.length} ${rest.length === 1 ? "report" : "reports"}`}
        </Text>
      ) : null}
      {row.outcome !== "gathering" ? (
        <Text variant="caption" tone="muted" className={rigidClass()}>
          {clock(row.at)}
        </Text>
      ) : null}
    </Inline>
  );
}
