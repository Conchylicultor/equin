import { useState } from "react";
import { useSurfaceFocused } from "@plugins/apps-core/plugins/tabs/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
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
import { formatResets, USAGE_WINDOWS } from "../internal/claude-usage";
import { useClaudeCodeRowInputs } from "../internal/use-claude-code-row";
import { ClaudeAccountsSection } from "./claude-accounts";
import { UsageBar, UsageMeter } from "./claude-usage-glance";

// The agent manager's sidebar foot: the Claude account new agents launch on,
// with its weekly quota at a glance (the limit worth choosing an account by).
// Click it — or Manage accounts in the health report's Claude Code row — for
// the menu: the session and week meters, every account, and the switches.

const chevronIcon = symbol("unfold-more");

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
    return (
      <Text variant="caption" tone="muted">
        Billed to API credit
      </Text>
    );
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
        />
      </Fill>
      <Rigid>
        <Text
          variant="caption"
          tone="muted"
          className={cn(
            "tabular-nums",
            view.kind === "current" && view.level === "high" && "text-warning",
          )}
        >
          {Math.round(used * 100)}%
        </Text>
      </Rigid>
    </Line>
  );
}

/** The menu's head: the active account, then its session and week meters. */
function ActiveAccountHead({
  account,
  usage,
  now,
}: {
  account: AccountView;
  usage: ClaudeUsageRead;
  now: number;
}) {
  const reading = usage.byAccount[account.id];
  return (
    <Stack gap="sm">
      <Line className="gap-sm">
        <Rigid>
          <Avatar fallbackGlyph={account.name} fallbackKey={account.id} />
        </Rigid>
        <Fill>
          <Stack gap="none">
            <Text tone="strong">{account.name}</Text>
            <Text variant="caption" tone="muted">
              {account.detail}
            </Text>
          </Stack>
        </Fill>
      </Line>
      {reading?.session || reading?.week ? (
        <Stack gap="xs">
          {reading.session ? (
            <UsageMeter id="session" window={reading.session} now={now} />
          ) : null}
          {reading.week ? (
            <UsageMeter id="week" window={reading.week} now={now} />
          ) : null}
        </Stack>
      ) : null}
    </Stack>
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
    <SidebarMenu>
      <SidebarMenuItem>
        <InlinePopover
          open={open}
          onOpenChange={onOpenChange}
          side="top"
          align="start"
          width="settings"
          trigger={
            <SidebarMenuButton size="lg" aria-label="Claude account">
              <Avatar fallbackGlyph={active.name} fallbackKey={active.id} />
              <Fill>
                <Stack gap="2xs">
                  <Text variant="caption" tone="strong">
                    {active.name}
                  </Text>
                  <WeekGlance account={active} usage={usage} now={now} />
                </Stack>
              </Fill>
              <Icon icon={chevronIcon} />
            </SidebarMenuButton>
          }
        >
          <Stack gap="md">
            <ActiveAccountHead account={active} usage={usage} now={now} />
            <ClaudeAccountsSection
              accounts={accounts}
              usage={usage}
              claude={claude}
              stopped={stopped}
              now={now}
            />
          </Stack>
        </InlinePopover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
