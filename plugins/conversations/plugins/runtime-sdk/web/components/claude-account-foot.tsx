import { useState } from "react";
import { useSurfaceFocused } from "@plugins/apps-core/plugins/tabs/web";
import {
  Avatar,
  AvatarPresentationProvider,
} from "@plugins/primitives/plugins/avatar/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  ControlSizeProvider,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  limitReached,
  viewUsageWindow,
  type ClaudeUsageRead,
} from "../../core";
import {
  settleAccountMenuRequest,
  useAccountMenuRequested,
} from "../internal/account-menu";
import {
  accountViews,
  activeAccountView,
  type AccountView,
} from "../internal/account-views";
import {
  formatResets,
  USAGE_WINDOWS,
  windowElapsed,
} from "../internal/claude-usage";
import { useClaudeCodeRowInputs } from "../internal/use-claude-code-row";
import { LEVEL_CLASS, PACE_LABEL } from "./account-head";
import { AccountSpendGlance } from "./account-spend-glance";
import { ClaudeAccountMenu } from "./claude-accounts";
import { UsageBar } from "./claude-usage-glance";

// The agent manager's sidebar foot: the Claude account new agents launch on,
// with its weekly quota at a glance (the limit worth choosing an account by).
// Click it — or Manage accounts in the health report's Claude Code row — for
// the menu (`ClaudeAccountMenu`): the session and week meters, every account,
// and the switches. The trigger's week bar ticks where an even pace would be.

const chevronIcon = symbol("expand-more");

/** The active account's week, in the trigger: a bar and its percent, or why not. */
function WeekGlance({
  account,
  usage,
  now,
}: {
  account: AccountView;
  usage: ClaudeUsageRead;
  now: number;
}) {
  if (account.metered)
    return <AccountSpendGlance accountId={account.id} now={now} />;
  const reading = usage.byAccount[account.id];
  const reached = limitReached(reading, now);
  if (reached)
    return (
      <Text variant="caption" tone="destructive">
        {USAGE_WINDOWS[reached.id].label} limit ·{" "}
        {formatResets(reached.id, reached.resetsAt, now)}
      </Text>
    );
  if (!reading?.week)
    return (
      <Text variant="caption" tone="faint">
        No usage reading yet
      </Text>
    );
  const view = viewUsageWindow(reading.week, now);
  const used = view.kind === "current" ? view.utilization : 0;
  return (
    <Line className="gap-sm">
      <Fill>
        <UsageBar
          fraction={used}
          level={view.kind === "current" ? view.level : "ok"}
          label="Week usage"
          size="thin"
          {...(view.kind === "current"
            ? {
                marker: windowElapsed("week", view.resetsAt, now),
                markerLabel: PACE_LABEL,
              }
            : {})}
        />
      </Fill>
      <Rigid>
        <Text
          variant="caption"
          tone="muted"
          className={cn(
            "tabular-nums",
            view.kind === "current" && LEVEL_CLASS[view.level],
          )}
        >
          {Math.round(used * 100)}%
        </Text>
      </Rigid>
    </Line>
  );
}

export function ClaudeAccountFoot() {
  const result = useClaudeCodeRowInputs();
  const [opened, setOpened] = useState(false);
  // Manage accounts in the health report asks the focused surface's foot.
  const requested = useAccountMenuRequested();
  const focused = useSurfaceFocused();
  const open = opened || (requested && focused);
  const onOpenChange = (next: boolean) => {
    setOpened(next);
    settleAccountMenuRequest();
  };
  // A minute's tick: "resets in" counts down, a passed reset shows as one.
  const now = useNow(60_000);
  switch (result.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the Claude account"
          error={result.error}
          refetch={result.refetch}
        />
      );
    // Not readable on this host (no computer behind it): no account to show.
    case "unavailable":
      return null;
    case "ready":
      break;
  }
  const { accounts, usage, claude, stopped } = result.data;
  const views = accountViews(accounts, claude);
  const active = activeAccountView(accounts, views);
  return (
    // The account surfaces draw people as solid discs, so the accounts side
    // by side tell apart at a glance.
    <AvatarPresentationProvider value="solid-badge">
      <SidebarMenu>
        <SidebarMenuItem>
          <ControlPanelPopover
            open={open}
            onOpenChange={onOpenChange}
            side="top"
            align="start"
            label="Claude account"
            trigger={
              // The mock's `.ac-trigger`: 6px block padding and 10px between
              // the avatar, the name and the chevron — this trigger's own
              // spacing, over the sidebar row's.
              <SidebarMenuButton
                size="lg"
                aria-label="Claude account"
                className="gap-smd py-xsm"
              >
                <ControlSizeProvider size="sm">
                  <Avatar fallbackGlyph={active.name} fallbackKey={active.id} />
                </ControlSizeProvider>
                <Fill>
                  <Stack gap="xs">
                    <Text variant="label" tone="strong">
                      {active.name}
                    </Text>
                    <WeekGlance account={active} usage={usage} now={now} />
                  </Stack>
                </Fill>
                <Icon
                  icon={chevronIcon}
                  className={cn(
                    "text-faint-foreground transition-transform",
                    open && "rotate-180",
                  )}
                />
              </SidebarMenuButton>
            }
          >
            <ClaudeAccountMenu
              accounts={accounts}
              usage={usage}
              claude={claude}
              stopped={stopped}
              now={now}
            />
          </ControlPanelPopover>
        </SidebarMenuItem>
      </SidebarMenu>
    </AvatarPresentationProvider>
  );
}
