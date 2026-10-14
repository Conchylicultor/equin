import {
  BUILD_STATUS_OPTIONS_META,
  buildStatusOf,
  killedSignalName,
  type BuildRunOutcome,
  type BuildStatus,
} from "@plugins/build/plugins/build-status/core";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";

/** Each status's dot colour — the one web-only fact beside its label and tint. */
const DOT_COLOR_CLASS: Record<BuildStatus, string> = {
  running: "bg-warning animate-pulse",
  success: "bg-success",
  failed: "bg-destructive",
  superseded: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
  killed: "bg-muted-foreground/60",
};

/**
 * Build-run status display metadata: the label and tint are core's
 * (`BUILD_STATUS_OPTIONS_META`, which the build arm's field declares its
 * options with), the dot colour is the web's.
 *
 * Declaration order is the order the filter dropdown offers
 * (`BUILD_STATUS_OPTIONS` is derived from it, never hand-written).
 */
export const BUILD_STATUS_META: Record<
  BuildStatus,
  { label: string; badgeVariant: BadgeVariant; dotColorClass: string }
> = Object.fromEntries(
  (
    Object.entries(BUILD_STATUS_OPTIONS_META) as [
      BuildStatus,
      (typeof BUILD_STATUS_OPTIONS_META)[BuildStatus],
    ][]
  ).map(([status, o]) => [
    status,
    {
      label: o.label,
      badgeVariant: o.variant,
      dotColorClass: DOT_COLOR_CLASS[status],
    },
  ]),
) as Record<
  BuildStatus,
  { label: string; badgeVariant: BadgeVariant; dotColorClass: string }
>;

export const BUILD_STATUS_OPTIONS: { value: BuildStatus; label: string }[] = (
  Object.entries(BUILD_STATUS_META) as [BuildStatus, { label: string }][]
).map(([value, meta]) => ({ value, label: meta.label }));

/**
 * The one fact that separates runs sharing a status, appended to the label: the
 * exit code for a failure, the signal for an external kill. Total — a status
 * with nothing to add renders as its bare label, never as an empty badge.
 */
function buildStatusText(run: BuildRunOutcome, status: BuildStatus): string {
  const { label } = BUILD_STATUS_META[status];
  if (run.exitCode === null) return label;
  if (status === "failed") return `${label} (exit ${run.exitCode})`;
  if (status === "killed")
    return `${label} (${killedSignalName(run.exitCode)})`;
  return label;
}

/** The run's status as a dot alone, for list rows that carry their own label. */
export function BuildStatusDot({ run }: { run: BuildRunOutcome }) {
  return (
    <StatusDot
      colorClass={BUILD_STATUS_META[buildStatusOf(run)].dotColorClass}
    />
  );
}

/** Dot + label, for a row or a table cell. */
export function BuildStatusChip({ run }: { run: BuildRunOutcome }) {
  const status = buildStatusOf(run);
  return (
    <Inline gap="xs">
      <StatusDot colorClass={BUILD_STATUS_META[status].dotColorClass} />
      {BUILD_STATUS_META[status].label}
    </Inline>
  );
}

/** The full badge for a detail surface: colour, label, and the run's own detail. */
export function BuildStatusBadge({ run }: { run: BuildRunOutcome }) {
  const status = buildStatusOf(run);
  const meta = BUILD_STATUS_META[status];
  return (
    <Badge
      variant={meta.badgeVariant}
      icon={<StatusDot colorClass={meta.dotColorClass} />}
    >
      {buildStatusText(run, status)}
    </Badge>
  );
}
