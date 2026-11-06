import {
  HOLD_SPECS,
  pickupTargetMsFor,
} from "@plugins/infra/plugins/jobs/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  formatThresholdMs,
  type QueueClassPulse,
  type QueueDeadGroup,
  type QueuePulse,
  type QueueRunningJob,
  type QueueTone,
  type QueueWaitingJob,
} from "../../core";
import {
  formatDurationMs,
  formatLatencyMs,
} from "../../shared/format-duration";
import { useAgeClock } from "../internal/use-age-clock";
import {
  useQueuePulse,
  type QueuePulseRead,
} from "../internal/use-queue-health";

// The Job queue row's expandable detail: the jobs that explain its colour, then
// how quickly each class has been picking work up.
//
// When the row is NOT green it lists only what coloured it — dead jobs inside
// the attention window, jobs waiting past their class's line, stuck jobs — and
// folds everything else into one "+ N more" line. When it is green, it lists
// what is running (at most one row per slot) and the deaths of the last day.
// The full queue is Debug → Queue, one click away on the row's action.

const DOT_CLASS: Record<QueueTone, string> = {
  ok: cn("bg-success"),
  attention: cn("bg-warning"),
  critical: cn("bg-destructive"),
};
const META_CLASS: Record<QueueTone, string> = {
  ok: cn("text-muted-foreground"),
  attention: cn("text-warning"),
  critical: cn("text-destructive"),
};
const QUIET_DOT_CLASS = cn("bg-muted-foreground/50");

type DetailItem =
  | { kind: "dead"; group: QueueDeadGroup }
  | { kind: "waiting"; job: QueueWaitingJob }
  | { kind: "running"; job: QueueRunningJob };

interface DetailModel {
  items: DetailItem[];
  /** "+ 3 more running · + 2 more waiting", or `null` when nothing is folded. */
  more: string | null;
  behindLanes: number;
  orphanLocked: number;
}

/** Which jobs the detail names, and what it folds away. */
export function detailModel(pulse: QueuePulse): DetailModel {
  const explaining = pulse.verdict.state !== "ok";
  const dead = explaining ? pulse.dead.filter((d) => d.recent) : pulse.dead;
  const waiting = explaining
    ? pulse.oldestWaiting.filter((w) => w.tone !== "ok")
    : [];
  const running = explaining
    ? pulse.running.filter((r) => r.stuck)
    : pulse.running;

  const totalWaiting = pulse.classes.reduce((sum, c) => sum + c.waiting, 0);
  const moreRunning = pulse.running.length - running.length;
  const moreWaiting = totalWaiting - waiting.length;
  const more = [
    moreRunning > 0 &&
      `+ ${moreRunning} ${running.length > 0 ? "more " : ""}running`,
    moreWaiting > 0 &&
      `+ ${moreWaiting} ${waiting.length > 0 ? "more " : ""}waiting`,
  ].filter((part): part is string => part !== false);

  return {
    items: [
      ...dead.map((group): DetailItem => ({ kind: "dead", group })),
      ...waiting.map((job): DetailItem => ({ kind: "waiting", job })),
      ...running.map((job): DetailItem => ({ kind: "running", job })),
    ],
    more: more.length > 0 ? more.join(" · ") : null,
    behindLanes: pulse.classes.reduce((sum, c) => sum + c.behindLanes, 0),
    orphanLocked: pulse.orphanLocked,
  };
}

/** The instant an item's displayed age counts from. */
function anchorOf(item: DetailItem): number {
  switch (item.kind) {
    case "dead":
      return item.group.lastDiedAt;
    case "waiting":
      return item.job.runAt;
    case "running":
      return item.job.lockedAt;
  }
}

function ItemLine({
  tone,
  quiet,
  name,
  hold,
  meta,
  title,
  kind,
}: {
  tone: QueueTone;
  /** A muted dot: listed for context, not colouring the row. */
  quiet?: boolean;
  name: string;
  hold?: QueueRunningJob["hold"];
  meta: string;
  title?: string;
  kind: DetailItem["kind"];
}) {
  return (
    <Line className="gap-sm" title={title} data-queue-item={kind}>
      <StatusDot colorClass={quiet ? QUIET_DOT_CLASS : DOT_CLASS[tone]} />
      <Fill>
        <Text variant="caption" className="font-mono">
          {name}
        </Text>
      </Fill>
      {hold ? (
        <Badge className={rigidClass()}>{HOLD_SPECS[hold].label}</Badge>
      ) : null}
      <Text variant="caption" className={cn(rigidClass(), META_CLASS[tone])}>
        {meta}
      </Text>
    </Line>
  );
}

function DetailItemLine({ item, now }: { item: DetailItem; now: number }) {
  const age = formatDurationMs(now - anchorOf(item));
  switch (item.kind) {
    case "dead": {
      const g = item.group;
      const times = g.count > 1 ? ` ×${g.count}` : "";
      return (
        <ItemLine
          kind="dead"
          tone={g.recent ? "critical" : "ok"}
          quiet={!g.recent}
          name={g.jobName}
          meta={`failed${times} · ${age} ago`}
          title={g.lastError ?? undefined}
        />
      );
    }
    case "waiting": {
      const j = item.job;
      const retry = j.attempts > 0 ? ` · attempt ${j.attempts + 1}` : "";
      return (
        <ItemLine
          kind="waiting"
          tone={j.tone}
          name={j.jobName}
          hold={j.hold}
          meta={`waiting ${age}${retry}`}
        />
      );
    }
    case "running": {
      const j = item.job;
      const state = j.forfeited ? "written off · " : j.stuck ? "stuck · " : "";
      return (
        <ItemLine
          kind="running"
          tone={j.stuck ? "attention" : "ok"}
          name={j.jobName}
          hold={j.hold}
          meta={`${state}running ${age}`}
        />
      );
    }
  }
}

/**
 * One class's pickup delay over the server's window. Amber when p95 is over the
 * class's target — but it never colours the dot: the stats describe the past,
 * and the dot describes now.
 */
function PickupLine({
  cls,
  windowLabel,
}: {
  cls: QueueClassPulse;
  windowLabel: string;
}) {
  const target = pickupTargetMsFor(cls.hold);
  const { count, p50Ms, p95Ms, maxMs } = cls.pickup;
  const slow = p95Ms !== null && p95Ms > target;
  const text =
    count === 0 || p50Ms === null || p95Ms === null || maxMs === null
      ? `no pickups in the last ${windowLabel}`
      : `p50 ${formatLatencyMs(p50Ms)} · p95 ${formatLatencyMs(p95Ms)} · max ${formatLatencyMs(maxMs)}`;
  return (
    <Line className="gap-sm" data-queue-pickup={cls.hold}>
      <Text variant="caption" tone="muted" className={cn(rigidClass(), "w-14")}>
        {HOLD_SPECS[cls.hold].label}
      </Text>
      <Fill>
        <Text
          variant="caption"
          className={slow ? "text-warning" : "text-muted-foreground"}
        >
          {text}
        </Text>
      </Fill>
      <Text variant="caption" tone="muted" className={rigidClass()}>
        target {formatThresholdMs(target)}
      </Text>
    </Line>
  );
}

function ReadyDetail({ pulse, now }: { pulse: QueuePulse; now: number }) {
  const model = detailModel(pulse);
  const windowLabel = formatThresholdMs(pulse.pickupWindowMs);
  return (
    <Stack gap="sm">
      {model.items.length > 0 || model.more ? (
        <Stack gap="2xs">
          {/* Not a DataView: at most a handful of lines (≤ 5 dead, ≤ 5
              waiting, ≤ one per slot running) in a transient popover, and the
              full, filterable list is Debug → Queue. Not Rows either: nothing
              here is clickable, and a Row's hover tint would promise that it
              was. */}
          {model.items.map((item) => (
            <DetailItemLine
              key={`${item.kind}:${item.kind === "dead" ? item.group.jobName : item.job.jobId}`}
              item={item}
              now={now}
            />
          ))}
          {model.more ? (
            <Text variant="caption" tone="muted">
              {model.more}
            </Text>
          ) : null}
        </Stack>
      ) : null}
      {model.behindLanes > 0 || model.orphanLocked > 0 ? (
        <Stack gap="2xs">
          {model.behindLanes > 0 ? (
            <Text variant="caption" tone="muted">
              {model.behindLanes} queued behind serial lanes — they wait for
              their lane by design, so they never colour the row.
            </Text>
          ) : null}
          {model.orphanLocked > 0 ? (
            <Text variant="caption" tone="muted">
              {model.orphanLocked} locked by a worker that stopped — the
              stuck-lock sweeper reclaims these.
            </Text>
          ) : null}
        </Stack>
      ) : null}
      <Stack gap="2xs">
        <Text variant="eyebrow" tone="muted">
          Picked up in · last {windowLabel}
        </Text>
        {pulse.classes.map((cls) => (
          <PickupLine key={cls.hold} cls={cls} windowLabel={windowLabel} />
        ))}
      </Stack>
    </Stack>
  );
}

/** The detail for any read. `now` drives the live ages. */
export function QueueDetailView({
  read,
  now,
}: {
  read: QueuePulseRead;
  now: number;
}) {
  switch (read.kind) {
    case "loading":
      return <Loading label="Reading the queue…" />;
    case "disconnected":
      return (
        <Text variant="caption" tone="muted">
          The queue is read from this worktree&apos;s server, which is not
          connected right now.
        </Text>
      );
    case "error":
      return (
        <Text variant="caption" tone="muted">
          The server could not read the queue.
        </Text>
      );
    case "ready":
      return <ReadyDetail pulse={read.value} now={now} />;
  }
}

export function QueueDetail() {
  const read = useQueuePulse();
  const anchors =
    read.kind === "ready" ? detailModel(read.value).items.map(anchorOf) : [];
  const now = useAgeClock(anchors);
  return <QueueDetailView read={read} now={now} />;
}
