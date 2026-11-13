import { useMemo, type ReactElement } from "react";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";
import {
  isLiveSessionStatus,
  type SupervisorRole,
} from "@plugins/tasks/plugins/supervisor-roles/core";
import { useSessionTallies } from "../internal/reads";
import { sessionLabel, useSessionNumbers } from "../internal/format";
import { LaunchSessionButton, OpenSessionButton } from "./session-actions";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/**
 * The role's main action, in a band of its own under its name: the live
 * session (how it is going, Open session), else what is waiting and Launch
 * session.
 */
export function SessionBand({
  role,
  sessions,
  backlog,
  oldest,
}: {
  role: SupervisorRole;
  /** The role's sessions, newest first. */
  sessions: readonly TaskTreeRow[];
  backlog: number;
  /** The oldest backlog task's creation, or `null` for an empty backlog. */
  oldest: Date | null;
}): ReactElement {
  const live = sessions.find((s) => isLiveSessionStatus(s.status)) ?? null;
  return live ? (
    <LiveBand role={role} live={live} />
  ) : (
    <IdleBand
      role={role}
      last={sessions[0] ?? null}
      backlog={backlog}
      oldest={oldest}
    />
  );
}

function LiveBand({
  role,
  live,
}: {
  role: SupervisorRole;
  live: TaskTreeRow;
}): ReactElement {
  const numbers = useSessionNumbers(role.id);
  const one = useMemo(() => [live], [live]);
  const tallies = useSessionTallies(one);
  const tally = tallies.status === "ready" ? tallies.data.get(live.id) : null;
  const started = formatRelativeTime(new Date(live.createdAt));
  const sub = tally
    ? `Started ${started} · ${tally.done} done · ${tally.running} running · ${tally.dropped} dropped`
    : `Started ${started}`;
  return (
    <Card className="border-primary/40 bg-primary/10">
      <Stack direction="row" align="center" gap="md">
        <StatusDot colorClass="bg-success" />
        <Fill>
          <Stack gap="none">
            <Text variant="label">{`${sessionLabel(numbers, live)} is live`}</Text>
            <Text variant="caption" tone="muted">
              {sub}
            </Text>
          </Stack>
        </Fill>
        <OpenSessionButton taskId={live.id} />
      </Stack>
    </Card>
  );
}

function IdleBand({
  role,
  last,
  backlog,
  oldest,
}: {
  role: SupervisorRole;
  last: TaskTreeRow | null;
  backlog: number;
  oldest: Date | null;
}): ReactElement {
  const ready = role.name.trim() !== "" && role.prompt.trim() !== "";
  const waiting =
    backlog > 0 && oldest !== null
      ? `${backlog} waiting · oldest ${formatRelativeTime(oldest, "short")}`
      : last === null && !ready
        ? "Needs a prompt"
        : "Backlog clear";
  const lastSession =
    last === null
      ? ""
      : ` · last session ${dateFormat.format(new Date(last.createdAt))}`;
  return (
    <Card>
      <Stack direction="row" align="center" gap="md">
        <StatusDot ringClass="border-muted-foreground" />
        <Fill>
          <Stack gap="none">
            <Text variant="label">
              {last === null ? "No sessions yet" : "Idle"}
            </Text>
            <Text variant="caption" tone="muted">
              {waiting + lastSession}
            </Text>
          </Stack>
        </Fill>
        <LaunchSessionButton roleId={role.id} disabled={!ready} />
      </Stack>
    </Card>
  );
}
