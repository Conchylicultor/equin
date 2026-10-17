import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { HOLD_SPECS, type HoldClass } from "@plugins/infra/plugins/jobs/core";
import { formatAbsolute, formatDuration, formatWhen } from "../internal/format";
import type { JobListStatus, JobProblem } from "../internal/job-rows";
import { PROBLEM_LABEL, STATUS_META } from "../internal/status";

/**
 * An instant read relative to now, either way (`in 3m`, `12s ago`), ticking.
 * A future instant reads at full strength (it is still coming); a past one muted.
 */
export function WhenText({
  date,
  prefix,
  due = false,
}: {
  date: Date;
  /** What the instant is, for the tooltip ("Run at", "Finished"). */
  prefix?: string;
  /** A pending row's run-at: once passed, it reads `due` (runnable, waiting for a slot). */
  due?: boolean;
}) {
  const now = useNow(10_000);
  const future = date.getTime() > now;
  const tone = future ? "default" : "muted";
  const title = `${prefix === undefined ? "" : `${prefix} `}${formatAbsolute(date)}`;
  return (
    <Text tone={tone} className="tabular-nums" title={title}>
      {due && !future ? "due" : formatWhen(date, now)}
    </Text>
  );
}

/** The time since `since`, as a duration ticking every second. */
export function RunningDuration({
  since,
  overCeilingAt,
}: {
  since: Date;
  /** Past this many ms it reads in the warning tint. */
  overCeilingAt: number | null;
}) {
  const now = useNow(1000);
  const ms = now - since.getTime();
  const over = overCeilingAt !== null && ms > overCeilingAt;
  return (
    <Text className={over ? "tabular-nums text-warning" : "tabular-nums"}>
      {formatDuration(ms)}
    </Text>
  );
}

/** A finished duration, in the warning tint when over its hold class's ceiling. */
export function DurationText({
  ms,
  hold,
}: {
  ms: number;
  hold: HoldClass | null;
}) {
  const ceiling = hold === null ? null : HOLD_SPECS[hold].ceilingMs;
  const over = ceiling !== null && ms > ceiling;
  return over ? (
    <Text
      className="tabular-nums text-warning"
      title={`Over the ${HOLD_SPECS[hold ?? "instant"].label} ceiling (${formatDuration(ceiling)})`}
    >
      {formatDuration(ms)}
    </Text>
  ) : (
    <Text className="tabular-nums">{formatDuration(ms)}</Text>
  );
}

/** A status as a coloured dot + its label in the same colour. */
export function StatusLabel({ status }: { status: JobListStatus }) {
  const meta = STATUS_META[status];
  return (
    <Inline gap="xs">
      <StatusDot colorClass={meta.dot} />
      <Text className={meta.text}>{meta.label}</Text>
    </Inline>
  );
}

/** A status as a tinted badge with its dot (the detail header's form). */
export function StatusBadge({ status }: { status: JobListStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.badge} icon={<StatusDot colorClass={meta.dot} />}>
      {meta.label}
    </Badge>
  );
}

export function ProblemBadge({ problem }: { problem: JobProblem }) {
  return <Badge variant="destructive">{PROBLEM_LABEL[problem]}</Badge>;
}

export function HoldBadge({ hold }: { hold: HoldClass }) {
  return <Badge>{HOLD_SPECS[hold].label}</Badge>;
}

export function JobBadge({ name }: { name: string }) {
  return (
    <Badge variant="muted" mono tooltip={name}>
      {name}
    </Badge>
  );
}
