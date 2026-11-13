import { useMemo, type ReactElement } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { stateIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { isLiveSessionStatus } from "@plugins/tasks/plugins/supervisor-roles/core";
import { useSessionTallies, type SessionTally } from "../internal/reads";
import { useSessionNumbers } from "../internal/format";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const SESSIONS_VIEW = defineDataView("tasks.supervisor-roles.sessions");

const doneIcon = symbol("check-circle");
const droppedIcon = symbol("block");
const runningIcon = stateIcons.working;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const SESSION_PLACE = { tally: "trail", bar: "trail" } as const;

/** A role's session history, newest first: what each session came to. */
export function SessionsSection({
  roleId,
  sessions,
}: {
  roleId: string;
  sessions: readonly TaskTreeRow[];
}): ReactElement | null {
  return sessions.length === 0 ? null : (
    <SessionsList roleId={roleId} sessions={sessions} />
  );
}

function SessionsList({
  roleId,
  sessions,
}: {
  roleId: string;
  sessions: readonly TaskTreeRow[];
}): ReactElement {
  const numbers = useSessionNumbers(roleId);
  const tallies = useSessionTallies(sessions);
  const openPane = useOpenPane();
  const fields = useMemo<FieldDef<TaskTreeRow>[]>(
    () => [
      {
        id: "session",
        label: "Session",
        type: "text",
        primary: true,
        value: (s) => s.createdAt,
        cell: (s) => {
          const live = isLiveSessionStatus(s.status);
          const n = numbers?.get(s.id);
          return (
            <Inline gap="sm">
              {n === undefined ? null : (
                <Text variant="count" tone="muted">{`#${n}`}</Text>
              )}
              <Text variant="label">
                {live
                  ? `Started ${formatRelativeTime(new Date(s.createdAt))}`
                  : dateFormat.format(new Date(s.createdAt))}
              </Text>
              {live ? <Badge variant="success">Live</Badge> : null}
            </Inline>
          );
        },
        sortable: true,
      },
      {
        id: "bar",
        label: "Progress",
        type: "text",
        value: (s) => s.id,
        cell: (s) => <TallyBar tally={tallyOf(tallies, s.id)} />,
        filterable: false,
      },
      {
        id: "tally",
        label: "Done · dropped",
        type: "text",
        value: (s) => s.id,
        cell: (s) => <TallyCounts session={s} tally={tallyOf(tallies, s.id)} />,
        filterable: false,
      },
    ],
    [numbers, tallies],
  );
  return (
    <DataView<TaskTreeRow>
      rows={sessions as TaskTreeRow[]}
      fields={fields}
      rowKey={(s) => s.id}
      views={["list"]}
      storageKey={SESSIONS_VIEW}
      title={
        <Inline gap="sm">
          <Text variant="label" tone="strong">
            Sessions
          </Text>
          <Text variant="count" tone="muted">
            {sessions.length}
          </Text>
        </Inline>
      }
      place={SESSION_PLACE}
      rowActivation={(s) =>
        openPane.to(taskDetailPane, { taskId: s.id }, { mode: "push" })
      }
    />
  );
}

function tallyOf(
  tallies: ReturnType<typeof useSessionTallies>,
  id: string,
): SessionTally | null {
  return tallies.status === "ready" ? (tallies.data.get(id) ?? null) : null;
}

function tallyTitle(t: SessionTally): string {
  return [
    `${t.done} done`,
    `${t.dropped} dropped`,
    t.running > 0 && `${t.running} running`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The session's tree as one bar: done, running, dropped shares. */
function TallyBar({
  tally: t,
}: {
  tally: SessionTally | null;
}): ReactElement | null {
  if (t === null) return null;
  const total = t.done + t.running + t.dropped || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <Clip className="h-1.5 w-28 rounded-full bg-muted" title={tallyTitle(t)}>
      <Stack direction="row" gap="none" className="h-full">
        <span className="h-full bg-success" style={{ width: pct(t.done) }} />
        <span className="h-full bg-info" style={{ width: pct(t.running) }} />
        <span
          className="h-full bg-muted-foreground/40"
          style={{ width: pct(t.dropped) }}
        />
      </Stack>
    </Clip>
  );
}

/** Done, dropped (and, while live, running) counts. */
function TallyCounts({
  session,
  tally: t,
}: {
  session: TaskTreeRow;
  tally: SessionTally | null;
}): ReactElement | null {
  if (t === null) return null;
  return (
    <Inline gap="md" title={tallyTitle(t)}>
      <Inline gap="2xs">
        <Icon icon={doneIcon} className="size-3.5 text-success" />
        <Text variant="count">{t.done}</Text>
      </Inline>
      <Inline gap="2xs">
        <Icon icon={droppedIcon} className="size-3.5 text-muted-foreground" />
        <Text variant="count" tone={t.dropped === 0 ? "faint" : "muted"}>
          {t.dropped}
        </Text>
      </Inline>
      {isLiveSessionStatus(session.status) ? (
        <Inline gap="2xs">
          <Icon icon={runningIcon} className="size-3.5 text-info" />
          <Text variant="count">{t.running}</Text>
        </Inline>
      ) : null}
    </Inline>
  );
}
