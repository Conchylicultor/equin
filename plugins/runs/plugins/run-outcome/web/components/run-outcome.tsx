import type { ReactNode } from "react";
import {
  RUN_OUTCOME_OPTIONS_META,
  RUN_OUTCOMES,
  type RunOutcome,
} from "@plugins/runs/plugins/run-outcome/core";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";

/**
 * Run-outcome display metadata — the shape `BUILD_STATUS_META` established, for
 * the vocabulary every kind shares. The label and tint are the vocabulary's own
 * (`RUN_OUTCOME_OPTIONS_META`, core); the dot colour is the browser's.
 */
const DOT_COLOR_CLASS: Record<RunOutcome, string> = {
  running: "bg-warning animate-pulse",
  succeeded: "bg-success",
  partial: "bg-warning",
  failed: "bg-destructive",
  canceled: "bg-muted-foreground/60",
};

export const RUN_OUTCOME_META: Record<
  RunOutcome,
  { label: string; badgeVariant: BadgeVariant; dotColorClass: string }
> = Object.fromEntries(
  RUN_OUTCOMES.map((o) => [
    o,
    {
      label: RUN_OUTCOME_OPTIONS_META[o].label,
      badgeVariant: RUN_OUTCOME_OPTIONS_META[o].variant,
      dotColorClass: DOT_COLOR_CLASS[o],
    },
  ]),
) as Record<
  RunOutcome,
  { label: string; badgeVariant: BadgeVariant; dotColorClass: string }
>;

/**
 * The filter / group-by option list. Derived from the vocabulary rather than
 * hand-written, and derived from the *vocabulary* rather than from loaded rows:
 * the rows are a server-paginated window, so deriving would offer only the
 * outcomes that happen to be on screen.
 */
export const RUN_OUTCOME_OPTIONS: { value: RunOutcome; label: string }[] =
  RUN_OUTCOMES.map((value) => ({
    value,
    label: RUN_OUTCOME_META[value].label,
  }));

/** The outcome as a dot alone, for a row that carries its own label. */
export function RunOutcomeDot({ outcome }: { outcome: RunOutcome }): ReactNode {
  return <StatusDot colorClass={RUN_OUTCOME_META[outcome].dotColorClass} />;
}

/** Dot + label, for a list row or a table cell. */
export function RunOutcomeChip({
  outcome,
}: {
  outcome: RunOutcome;
}): ReactNode {
  return (
    <Inline gap="xs">
      <StatusDot colorClass={RUN_OUTCOME_META[outcome].dotColorClass} />
      {RUN_OUTCOME_META[outcome].label}
    </Inline>
  );
}

/** The full coloured badge, for a detail surface or an emphasised row. */
export function RunOutcomeBadge({
  outcome,
}: {
  outcome: RunOutcome;
}): ReactNode {
  const meta = RUN_OUTCOME_META[outcome];
  return (
    <Badge
      variant={meta.badgeVariant}
      icon={<StatusDot colorClass={meta.dotColorClass} />}
    >
      {meta.label}
    </Badge>
  );
}
