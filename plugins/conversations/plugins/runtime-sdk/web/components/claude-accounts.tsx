import { useState, type ReactNode } from "react";
import {
  EndpointError,
  getEndpointErrorMessage,
  useEndpointMutation,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import {
  addClaudeAccount,
  claudeAccountIds,
  claudeAccountRefs,
  removeClaudeAccount,
  selectClaudeAccount,
  setClaudeAccountAutoSwitch,
  SYSTEM_ACCOUNT_ID,
  type ClaudeAccounts,
  type ClaudeCredentialKind,
} from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  cn,
  ControlSizeProvider,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  StepAction,
  StepActions,
  StepCommand,
  StepLink,
  StepNote,
} from "@plugins/primitives/plugins/setup-steps/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  autoResumeConfig,
  launchAccount,
  limitReached,
  refreshClaudeUsage,
  roomiestAccount,
  usageLevel,
  weekRoom,
  type ClaudeUsageRead,
  type ErrorStoppedConversation,
} from "../../core";
import { formatResets, USAGE_WINDOWS } from "../internal/claude-usage";
import { UsageBar } from "./claude-usage-glance";
import { ErrorStoppedBanner } from "./error-stopped";

// The Claude Code row's accounts: which Claude account new agents launch on.
// Each account shows its weekly room only — the 5-hour session resets too
// often to choose an account by. Picking one switches; agents already running
// keep theirs until their process restarts. Adding or picking one reads its
// limits at once (no agent turn needed), so its room shows straight away. An
// API-key account has no plan limits: it is billed to its Console org (e.g.
// the plan's monthly API credit), and auto-switch uses it only as overflow.

const addIcon = symbol("add");
const removeIcon = symbol("close");

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

interface AccountView {
  id: string;
  name: string;
  detail: string;
  /** Billed per use (an API key): no plan limits to read or show. */
  metered: boolean;
}

/** The accounts in display order: the computer's own login first. */
function accountViews(
  accounts: ClaudeAccounts,
  claude: ClaudeCodeStatus,
): AccountView[] {
  const login =
    claude.kind === "ready"
      ? (claude.email ?? claude.authMethod ?? "Claude Code's sign-in")
      : "Claude Code's sign-in";
  return [
    {
      id: SYSTEM_ACCOUNT_ID,
      name: "This computer",
      detail: login,
      metered: false,
    },
    ...accounts.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      detail: a.kind === "api-key" ? "API key" : "Token",
      metered: a.kind === "api-key",
    })),
  ];
}

/**
 * Where this tab's own read of an account's limits stands: `reading` while it
 * runs, `unreadable` (with why) when Claude Code had no plan limits for it.
 */
type UsageRead =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "unreadable"; reason: string };

/** One account's weekly room, as words and a bar. */
function WeekRoomGlance({
  account,
  usage,
  read,
  now,
}: {
  account: AccountView;
  usage: ClaudeUsageRead;
  read: UsageRead;
  now: number;
}) {
  if (account.metered)
    return (
      <Text
        variant="caption"
        tone="muted"
        title="An API key has no plan limits: each request is billed to its Console organization — its monthly API credit first"
      >
        Billed to API credit
      </Text>
    );
  const reading = usage.byAccount[account.id];
  const room = weekRoom(reading, now);
  if (room.kind === "unknown") {
    switch (read.kind) {
      case "reading":
        return (
          <Text variant="caption" tone="faint">
            Reading usage…
          </Text>
        );
      case "unreadable":
        return (
          <Text variant="caption" tone="faint" title={read.reason}>
            Usage not readable
          </Text>
        );
      case "idle":
        return (
          <Text variant="caption" tone="faint">
            No reading yet
          </Text>
        );
    }
  }
  const used = 1 - room.left;
  const reached = limitReached(reading, now) !== null;
  const level = reached ? "full" : usageLevel(used);
  return (
    <Stack gap="2xs" align="end">
      <div className="w-14">
        <UsageBar fraction={used} level={level} label="Week usage" />
      </div>
      <Text
        variant="caption"
        tone={level === "full" ? "destructive" : "muted"}
        className={cn("tabular-nums", level === "high" && "text-warning")}
      >
        {reached ? "Limited" : `${percent(room.left)} left this week`}
      </Text>
    </Stack>
  );
}

/** The active account hit a limit: say until when, and offer the roomiest other. */
function LimitBanner({
  views,
  active,
  usage,
  now,
  onSwitch,
}: {
  views: AccountView[];
  active: AccountView;
  usage: ClaudeUsageRead;
  now: number;
  onSwitch: (id: string) => void;
}) {
  const reached = limitReached(usage.byAccount[active.id], now);
  if (!reached) return null;
  const nextId = roomiestAccount(
    views.filter((v) => v.id !== active.id),
    usage.byAccount,
    now,
  );
  const next = views.find((v) => v.id === nextId);
  const room = next ? weekRoom(usage.byAccount[next.id], now) : null;
  return (
    <Stack
      gap="xs"
      className="rounded-md border border-destructive/30 bg-destructive/10 p-sm"
    >
      <Text variant="caption">
        {active.name} hit its {USAGE_WINDOWS[reached.id].label.toLowerCase()}{" "}
        limit · {formatResets(reached.id, reached.resetsAt, now)}
      </Text>
      {next ? (
        <Line>
          <Fill />
          <Button onClick={() => onSwitch(next.id)}>
            Continue on {next.name}
            {next.metered
              ? " · API credit"
              : room?.kind === "known"
                ? ` · ${percent(room.left)} left`
                : ""}
          </Button>
        </Line>
      ) : null}
    </Stack>
  );
}

/** Where an API key's spend is claimed and keys are made. */
const PLAN_BILLING_URL = "https://claude.ai/settings/billing";
const CONSOLE_KEYS_URL = "https://platform.claude.com/settings/keys";

/** The steps that produce a credential of `kind`, ending at its paste box. */
function CredentialSteps({
  kind,
  input,
}: {
  kind: ClaudeCredentialKind;
  input: ReactNode;
}) {
  switch (kind) {
    case "token":
      return (
        <StepActions>
          <StepAction
            detail={
              <StepCommand text="claude setup-token" title="Copy command" />
            }
          >
            Sign in to the other account in a terminal
          </StepAction>
          <StepAction detail={input}>Paste the token it prints</StepAction>
        </StepActions>
      );
    case "api-key":
      return (
        <StepActions>
          <StepAction
            detail={<StepLink href={PLAN_BILLING_URL} label="Open billing" />}
          >
            On a Max or Team plan, claim its monthly API credit: link a Console
            organization under API credits
          </StepAction>
          <StepAction
            detail={<StepLink href={CONSOLE_KEYS_URL} label="Open API keys" />}
          >
            Create an API key in that organization
          </StepAction>
          <StepAction detail={input}>Paste the key</StepAction>
        </StepActions>
      );
  }
}

/** Add an account of `kind`: get its credential, then paste it with a name. */
function AddAccountForm({
  kind,
  onAdded,
  onCancel,
}: {
  kind: ClaudeCredentialKind;
  onAdded: (id: string, metered: boolean) => void;
  onCancel: () => void;
}) {
  const [credential, setCredential] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fetchEndpoint = useFetchEndpoint();
  const add = async () => {
    setError(null);
    let added;
    try {
      added = await fetchEndpoint(
        addClaudeAccount,
        {},
        { body: { name: name.trim(), credential: credential.trim() } },
      );
    } catch (err) {
      // A refused credential or name is the user's to fix: shown under the form.
      if (!(err instanceof EndpointError)) throw err;
      setError(getEndpointErrorMessage(err));
      return;
    }
    // The form renders only where the account endpoints are available.
    if (added.kind !== "ok") throw new Error(added.message);
    onAdded(added.value.id, added.value.kind === "api-key");
  };
  return (
    <Stack gap="sm" className="rounded-md border p-sm">
      <CredentialSteps
        kind={kind}
        input={
          <Stack gap="xs">
            <Input
              type="password"
              autoComplete="off"
              placeholder={
                kind === "api-key" ? "sk-ant-api03-…" : "sk-ant-oat01-…"
              }
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              className="font-mono"
            />
            <Input
              placeholder={
                kind === "api-key"
                  ? "Name — e.g. API credit"
                  : "Name — e.g. Work"
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Stack>
        }
      />
      {error ? (
        <Text variant="caption" tone="destructive">
          {error}
        </Text>
      ) : null}
      <Line className="gap-xs">
        <Fill />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!credential.trim() || !name.trim()} onClick={add}>
          {kind === "api-key" ? "Add API key" : "Add account"}
        </Button>
      </Line>
    </Stack>
  );
}

/**
 * The accounts section of the Claude Code row: every account with its weekly
 * room, the active one highlighted; a click switches. Plus the limit banner,
 * the conversations an API error stopped (with Resume all), adding an account and
 * the auto-switch toggle.
 */
export function ClaudeAccountsSection({
  accounts,
  usage,
  claude,
  stopped,
  now,
}: {
  accounts: ClaudeAccounts;
  usage: ClaudeUsageRead;
  claude: ClaudeCodeStatus;
  stopped: readonly ErrorStoppedConversation[];
  now: number;
}) {
  const [adding, setAdding] = useState<ClaudeCredentialKind | null>(null);
  // The account this tab switched to: running agents stay where they were.
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  // The switch shows at once; what depends on it landing (the usage read of
  // the account switched to) runs on the server's answer (`switchTo`).
  const selectAccount = useLiveMutation(selectClaudeAccount);
  const removeAccount = useLiveMutation(removeClaudeAccount);
  const autoSwitch = useLiveMutation(setClaudeAccountAutoSwitch);
  const refreshUsage = useEndpointMutation(refreshClaudeUsage);
  // Accounts Claude Code reported no plan limits for, with why.
  const [unreadable, setUnreadable] = useState<Record<string, string>>({});
  const views = accountViews(accounts, claude);
  const active = views.find((v) => v.id === accounts.active);
  if (!active) {
    throw new Error(
      `Claude accounts: the active account "${accounts.active}" is not one of ${claudeAccountIds(accounts).join(", ")}`,
    );
  }
  // One computer behind all three: the row's inputs, read off it, are
  // already ready, so this is the transport's own verdict.
  if (selectAccount.kind === "unavailable") {
    return <StepNote>{selectAccount.message}</StepNote>;
  }
  if (
    removeAccount.kind === "unavailable" ||
    autoSwitch.kind === "unavailable" ||
    refreshUsage.kind === "unavailable"
  )
    throw new Error("Claude accounts: endpoints disagree on the computer");
  // Its last reading is missing, or from before the switch: read it now.
  const readUsage = (accountId: string) =>
    refreshUsage.mutate(
      { body: { accountId } },
      {
        onSuccess: (result) =>
          setUnreadable(({ [accountId]: _, ...rest }) =>
            result.kind === "unavailable"
              ? { ...rest, [accountId]: result.reason }
              : rest,
          ),
      },
    );
  const usageRead = (accountId: string): UsageRead => {
    if (
      refreshUsage.isPending &&
      refreshUsage.variables.body.accountId === accountId
    )
      return { kind: "reading" };
    const reason = unreadable[accountId];
    return reason === undefined
      ? { kind: "idle" }
      : { kind: "unreadable", reason };
  };
  // Where a resumed agent restarts: the launch's own choice.
  const launchId = launchAccount({
    accounts: claudeAccountRefs(accounts),
    active: accounts.active,
    autoSwitch: accounts.autoSwitch,
    byAccount: usage.byAccount,
    now,
  });
  const launchView = views.find((v) => v.id === launchId) ?? active;
  const switchTo = (id: string) =>
    selectAccount.mutate(
      { body: { id } },
      {
        onSuccess: () => {
          setSwitchedTo(id);
          // An API key has no plan limits to read.
          if (!views.find((v) => v.id === id)?.metered) readUsage(id);
        },
      },
    );
  return (
    <ControlSizeProvider size="sm">
      <Stack gap="sm">
        <LimitBanner
          views={views}
          active={active}
          usage={usage}
          now={now}
          onSwitch={switchTo}
        />
        <ErrorStoppedBanner
          stopped={stopped}
          launchAccountId={launchView.id}
          launchAccountName={launchView.name}
          usage={usage}
          now={now}
        />
        <Stack gap="2xs">
          <Text variant="eyebrow" tone="muted">
            Accounts
          </Text>
          {/* eslint-disable-next-line data-view/no-adhoc-row-list -- a picker: the rows choose the one account new agents launch on, not a browsable collection */}
          {views.map((v) => (
            <Row
              key={v.id}
              size="sm"
              selected={v.id === active.id}
              onClick={v.id === active.id ? undefined : () => switchTo(v.id)}
              title={
                v.id === active.id
                  ? "New agents launch on this account"
                  : `Launch new agents on ${v.name}`
              }
              icon={<Avatar fallbackGlyph={v.name} fallbackKey={v.id} />}
              actions={
                v.id === SYSTEM_ACCOUNT_ID ? undefined : (
                  <IconButton
                    icon={removeIcon}
                    label={`Remove ${v.name}`}
                    onClick={() => removeAccount.mutate({ body: { id: v.id } })}
                  />
                )
              }
            >
              <Fill>
                <Stack gap="none">
                  <Text variant="caption" tone="strong">
                    {v.name}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {v.detail}
                  </Text>
                </Stack>
              </Fill>
              <Rigid>
                <WeekRoomGlance
                  account={v}
                  usage={usage}
                  read={usageRead(v.id)}
                  now={now}
                />
              </Rigid>
            </Row>
          ))}
          {adding ? (
            <AddAccountForm
              kind={adding}
              onAdded={(id, metered) => {
                setAdding(null);
                if (!metered) readUsage(id);
              }}
              onCancel={() => setAdding(null)}
            />
          ) : (
            <>
              <Row
                size="sm"
                onClick={() => setAdding("token")}
                icon={<Icon icon={addIcon} />}
              >
                <Text variant="caption" tone="muted">
                  Add plan account
                </Text>
              </Row>
              <Row
                size="sm"
                onClick={() => setAdding("api-key")}
                icon={<Icon icon={addIcon} />}
                title="Run agents on an API key — e.g. the monthly API credit a Max or Team plan includes"
              >
                <Text variant="caption" tone="muted">
                  Add API key
                </Text>
              </Row>
            </>
          )}
        </Stack>
        <Line className="gap-sm">
          <Fill>
            <Text variant="caption" tone="muted">
              Switch to the next account when one hits its limit
              {views.some((v) => v.metered)
                ? " — an API key only while every plan account has"
                : ""}
            </Text>
          </Fill>
          <Rigid>
            <Switch
              checked={accounts.autoSwitch}
              aria-label="Switch to the next account when one hits its limit"
              onCheckedChange={(enabled) =>
                autoSwitch.mutate({ body: { enabled } })
              }
            />
          </Rigid>
        </Line>
        <AutoResumeSwitch />
        {switchedTo === active.id ? (
          <StepNote>
            {active.metered && accounts.autoSwitch
              ? `With auto-switch on, new agents launch on ${active.name} only while every plan account is at its limit.`
              : `New agents launch on ${active.name}.`}{" "}
            Agents already running keep their account until they restart.
          </StepNote>
        ) : null}
      </Stack>
    </ControlSizeProvider>
  );
}

/**
 * Resume agents a usage limit stopped once it resets (this backend's agents:
 * the setting, like the agents, is the namespace's own).
 */
function AutoResumeSwitch() {
  const config = useConfigResult(autoResumeConfig);
  const set = useSetConfig(autoResumeConfig);
  switch (config.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the auto-resume setting"
          error={config.error}
          refetch={config.refetch}
        />
      );
    case "ready":
      break;
  }
  const { enabled } = config.data;
  return (
    <Line className="gap-sm">
      <Fill>
        <Text variant="caption" tone="muted">
          Resume stopped agents when their limit resets
        </Text>
      </Fill>
      <Rigid>
        <Switch
          checked={enabled}
          aria-label="Resume stopped agents when their limit resets"
          onCheckedChange={(next) => set("enabled", next)}
        />
      </Rigid>
    </Line>
  );
}
