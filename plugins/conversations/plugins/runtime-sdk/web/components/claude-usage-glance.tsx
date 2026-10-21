import type { GlanceProps } from "@plugins/shell/plugins/health-report/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { claudeUsage, type ClaudeUsageWindow } from "../../core";
import {
  formatResets,
  USAGE_WINDOWS,
  viewUsageWindow,
  type UsageLevel,
  type UsageWindowId,
} from "../internal/claude-usage";

// The Claude Code row's glance: the subscription's usage limits as meters.
// Collapsed, the week alone (the limit that decides the days ahead); expanded,
// the session above it. It sits inside the row's click target: no controls.

const FILL_CLASS: Record<UsageLevel, string> = {
  ok: cn("bg-primary"),
  high: cn("bg-warning"),
  full: cn("bg-destructive"),
};
const PERCENT_CLASS: Record<UsageLevel, string> = {
  ok: cn("text-foreground"),
  high: cn("text-warning"),
  full: cn("text-destructive"),
};

function UsageMeter({
  id,
  window,
  now,
}: {
  id: UsageWindowId;
  window: ClaudeUsageWindow;
  now: number;
}) {
  const { label } = USAGE_WINDOWS[id];
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
      <Clip
        role="meter"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        className="h-1 rounded-full bg-input"
      >
        {view.kind === "current" ? (
          <div
            className={cn("h-full rounded-full", FILL_CLASS[view.level])}
            style={{ width: `${(fraction * 100).toFixed(1)}%` }}
          />
        ) : null}
      </Clip>
    </Stack>
  );
}

/**
 * The usage limits, as the agents last reported them. Nothing until one has:
 * the summary already speaks for the row, and an empty meter would claim an
 * unused week.
 */
export function ClaudeUsageGlance({ expanded }: GlanceProps) {
  const read = useLive(claudeUsage);
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
  if (read.data.kind === "none") return null;
  const { session, week } = read.data.usage;
  return (
    <Stack gap="xs">
      {expanded && session ? (
        <UsageMeter id="session" window={session} now={now} />
      ) : null}
      {week ? <UsageMeter id="week" window={week} now={now} /> : null}
    </Stack>
  );
}
