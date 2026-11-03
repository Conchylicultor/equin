import type { GlanceProps } from "@plugins/shell/plugins/health-report/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { combineResources } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Meter,
  type MeterSize,
  type MeterTone,
} from "@plugins/primitives/plugins/css/plugins/meter/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { claudeAccounts } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { useClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { accountViews, activeAccountView } from "../internal/account-views";
import {
  claudeUsage,
  viewUsageWindow,
  type ClaudeUsageWindow,
  type UsageLevel,
  type UsageWindowId,
} from "../../core";
import { formatResets, USAGE_WINDOWS } from "../internal/claude-usage";

// The Claude Code row's glance: the active account's usage limits as meters.
// Collapsed, the week alone (the limit that decides the days ahead); expanded,
// the session below it, so the week never moves. It sits inside the row's
// click target: no controls.

const TONE: Record<UsageLevel, MeterTone> = {
  ok: "default",
  high: "warning",
  full: "destructive",
};
const PERCENT_CLASS: Record<UsageLevel, string> = {
  ok: cn("text-foreground"),
  high: cn("text-warning"),
  full: cn("text-destructive"),
};

/** A usage meter: `fraction` of the track filled in its level's tone. */
export function UsageBar({
  fraction,
  level,
  label,
  size,
  marker,
  markerLabel,
}: {
  fraction: number;
  /** `null`: nothing to fill (no current reading). */
  level: UsageLevel | null;
  label: string;
  size?: MeterSize;
  /** A pace / target tick at this fraction. */
  marker?: number;
  markerLabel?: string;
}) {
  return (
    <Meter
      value={level ? fraction : 0}
      label={label}
      tone={level ? TONE[level] : "default"}
      size={size}
      marker={marker}
      markerLabel={markerLabel}
    />
  );
}

export function UsageMeter({
  id,
  window,
  now,
  account,
}: {
  id: UsageWindowId;
  window: ClaudeUsageWindow;
  now: number;
  /** Whose limit it is, named ahead of the label (the health row's glance). */
  account?: string;
}) {
  const label = account
    ? `${account} · ${USAGE_WINDOWS[id].label}`
    : USAGE_WINDOWS[id].label;
  const view = viewUsageWindow(window, now);
  const fraction = view.kind === "current" ? Math.min(1, view.utilization) : 0;
  return (
    <Stack gap="2xs">
      <Line className="gap-sm">
        <Fill>
          <Text variant="caption" tone="muted">
            {label}{" "}
            {view.kind === "current"
              ? formatResets(id, view.resetsAt, now)
              : "· reset since the last reading"}
          </Text>
        </Fill>
        {view.kind === "current" ? (
          <Rigid>
            <Text
              variant="caption"
              className={cn("tabular-nums", PERCENT_CLASS[view.level])}
            >
              {Math.round(view.utilization * 100)}%
            </Text>
          </Rigid>
        ) : null}
      </Line>
      <UsageBar
        fraction={fraction}
        level={view.kind === "current" ? view.level : null}
        label={`${label} usage`}
      />
    </Stack>
  );
}

/**
 * The active account's usage limits, as its agents last reported them.
 * Nothing until one has: the summary already speaks for the row, and an empty
 * meter would claim an unused week.
 */
export function ClaudeUsageGlance({ expanded }: GlanceProps) {
  const read = combineResources({
    usage: useLive(claudeUsage),
    accounts: useLive(claudeAccounts),
    claude: useClaudeCodeStatus(),
  });
  // A minute's tick: "resets in" counts down, a passed reset shows as one.
  const now = useNow(60_000);
  switch (read.status) {
    // Not known yet, or unreadable: the row's summary says which.
    case "loading":
    case "error":
    case "unavailable":
      return null;
    case "ready":
      break;
  }
  const { accounts, claude } = read.data;
  const usage = read.data.usage.byAccount[accounts.active];
  if (!usage) return null;
  const { session, week } = usage;
  const active = activeAccountView(accounts, accountViews(accounts, claude));
  return (
    <Stack gap="xs">
      {week ? (
        <UsageMeter id="week" window={week} now={now} account={active.name} />
      ) : null}
      {expanded && session ? (
        <UsageMeter id="session" window={session} now={now} />
      ) : null}
    </Stack>
  );
}
