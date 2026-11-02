import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  viewUsageWindow,
  type ClaudeUsageRead,
  type ClaudeUsageWindow,
  type UsageLevel,
  type UsageWindowId,
} from "../../core";
import type { AccountView } from "../internal/account-views";
import {
  formatResets,
  USAGE_WINDOWS,
  windowElapsed,
} from "../internal/claude-usage";
import { UsageBar } from "./claude-usage-glance";

// The account menu's head: the active account, then its session and week
// meters — each a line (the window, when it resets, how much is used) over its
// bar, the week's with a tick where an even pace through it would be.

/** A percent's colour by how close the window is to its limit. */
export const LEVEL_CLASS: Record<UsageLevel, string> = {
  ok: "",
  high: cn("text-warning"),
  full: cn("text-destructive"),
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where an even pace through the week would be, for the week's bar. */
export const PACE_LABEL = "An even pace through the week";

/** One window's meter: `Week   Resets Thu 09:00   51%`, its bar under it. */
function AccountMeter({
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
  return (
    <Stack gap="xs">
      <Line className="gap-sm">
        <Rigid>
          <Text variant="caption" tone="strong">
            {label}
          </Text>
        </Rigid>
        <Fill>
          <Text variant="caption" tone="faint">
            {view.kind === "current"
              ? view.level === "full"
                ? `Limit reached · ${formatResets(id, view.resetsAt, now)}`
                : capitalize(formatResets(id, view.resetsAt, now))
              : "Reset since the last reading"}
          </Text>
        </Fill>
        {view.kind === "current" ? (
          <Rigid>
            <Text
              variant="count"
              tone="strong"
              className={LEVEL_CLASS[view.level]}
            >
              {Math.round(Math.min(1, view.utilization) * 100)}%
            </Text>
          </Rigid>
        ) : null}
      </Line>
      <UsageBar
        fraction={view.kind === "current" ? view.utilization : 0}
        level={view.kind === "current" ? view.level : null}
        label={`${label} usage`}
        {...(id === "week" && view.kind === "current"
          ? {
              marker: windowElapsed(id, view.resetsAt, now),
              markerLabel: PACE_LABEL,
            }
          : {})}
      />
    </Stack>
  );
}

/** The active account (name, detail), then its session and week meters. */
export function AccountHead({
  account,
  usage,
  now,
}: {
  account: AccountView;
  usage: ClaudeUsageRead;
  now: number;
}) {
  const reading = usage.byAccount[account.id];
  // Inset from the band's rules above and below (the mock's head and meters
  // padding: 6px over the head, 6px under the meters), the head and the
  // meters a step apart (its 4px + 8px), the avatar 10px from the name.
  return (
    <Stack gap="md" className="pt-xsm pb-xsm">
      <Line className="gap-smd">
        <Rigid>
          <ControlSizeProvider size="md">
            <Avatar fallbackGlyph={account.name} fallbackKey={account.id} />
          </ControlSizeProvider>
        </Rigid>
        <Fill>
          <Stack gap="none">
            <Text variant="label" tone="strong">
              {account.name}
            </Text>
            <Text variant="caption" tone="muted">
              {account.detail}
            </Text>
          </Stack>
        </Fill>
      </Line>
      {reading?.session || reading?.week ? (
        // The mock's `.ac-meters` gap: 10px between the two meters.
        <Stack gap="smd">
          {reading.session ? (
            <AccountMeter id="session" window={reading.session} now={now} />
          ) : null}
          {reading.week ? (
            <AccountMeter id="week" window={reading.week} now={now} />
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
