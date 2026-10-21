import { useConversations } from "@plugins/conversations/web";
import {
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import {
  CONVERSATIONS_CATEGORY_ID,
  type ConversationEntry,
} from "@plugins/conversations/core";
import { useTaskLaunch } from "@plugins/primitives/plugins/launch/web";
import {
  LaunchOptionPills,
  type LaunchOptionValues,
} from "@plugins/tasks/plugins/launch-options/web";
import { useClaudeCodeLaunchBlock } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ComposerField } from "@plugins/primitives/plugins/text-editor/plugins/composer/web";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { AmbientField } from "@plugins/ui/plugins/ambient-field/web";
import { useRef } from "react";

const sendIcon = symbol("arrow-upward");

const NEEDS_YOU_DOT = "bg-warning";
const RUNNING_DOT = "bg-success";

/**
 * The agent manager's home: the date and a greeting, ONE prompt that starts an
 * agent, and one line of counts under it — nothing else, over a barely-there
 * ambient field that recedes behind the column.
 */
export function WelcomeView() {
  const conv = useConversations();
  const now = new Date();
  const column = useRef<HTMLElement>(null);

  // The counts describe the user's conversations, so they render only once those
  // are known — a loading read shows nothing, never a zero it would then take
  // back; a failed one says so, where the counts would be.
  return (
    // A size container, so the column's offset is a share of the PANE's height
    // (`cqh`), not the browser viewport's — in a small window (a desktop
    // window, a split) a `vh` offset would push the prompt to the pane's foot.
    <AmbientField recedeBehind={column}>
      <Scroll className="h-full [container-type:size]">
        <Stack
          ref={column}
          gap="xl"
          // eslint-disable-next-line spacing/no-adhoc-spacing -- the column sits a little above the middle of the pane, where the eye lands, and stays put while the prompt grows
          className="mx-auto w-full max-w-2xl px-xl pt-[28cqh] pb-2xl"
        >
          <Stack gap="xs">
            <Text as="div" variant="caption" tone="faint">
              {now.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </Text>
            <Text as="h1" variant="display" className="tracking-tight">
              {greeting(now)}
            </Text>
          </Stack>
          <Stack gap="lg">
            <HomePrompt />
            {matchResource(conv, {
              loading: () => null,
              error: (error) => (
                <ResourceErrorInline
                  variant="inline"
                  subject="your conversations"
                  error={error}
                  refetch={conv.refetch}
                />
              ),
              ready: (data) => (
                <Counts
                  {...partition(data.active)}
                  total={data.active.length + data.totalGoneCount}
                />
              ),
            })}
          </Stack>
        </Stack>
      </Scroll>
    </AmbientField>
  );
}

/** The two counts the home shows: waiting on the user, and running. */
function partition(active: ConversationEntry[]) {
  return {
    needsYou: active.filter((c) => c.status === "waiting").length,
    running: active.filter(
      (c) => c.status === "working" || c.status === "starting",
    ).length,
  };
}

function greeting(d: Date): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}

/** What the user has typed and picked, and not launched yet. */
type HomeDraft = {
  text: string;
  /** Only the launch options the user changed; the rest read through to defaults. */
  picked: LaunchOptionValues;
};

const homeDraftStore = defineStore<HomeDraft>({
  owner: "agent-manager.home-prompt",
  label: "Home prompt drafts",
  area: "local",
  cap: "64 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.object({
    text: z.string(),
    picked: z.record(z.string(), z.unknown()),
  }),
  legacy: legacyDraftKeys("agent-manager-home:prompt"),
});

/** How long the fallback task title may be — the title model replaces it. */
const TITLE_CHARS = 80;

/**
 * The one prompt: Enter (or the round send button) files a task carrying the
 * bar's launch options — the same pills as the Improve and Launch popovers:
 * model, thinking mode, preprompt — starts it, and opens the conversation in
 * place of the home. The unsent draft survives a reload.
 */
function HomePrompt() {
  const [draft, setDraft, clearDraft] = useDraft(homeDraftStore, {
    text: "",
    picked: {},
  });
  const { resolveOptions, launch, availability } = useTaskLaunch({
    openAfterLaunch: true,
    openMode: "root",
  });
  const options = resolveOptions(draft.picked);
  const setPicked = (picked: LaunchOptionValues) =>
    setDraft((d) => ({ ...d, picked }));
  // No computer behind this subtree (an in-browser server), or Claude Code
  // missing or signed out: the send button says why, rather than filing a
  // launch that cannot run.
  const claudeBlock = useClaudeCodeLaunchBlock();
  const blockReason = availability.available
    ? claudeBlock
    : availability.message;
  const prompt = draft.text.trim();
  const canSend = prompt !== "" && blockReason === null;

  const send = async () => {
    if (!canSend) return;
    // A placeholder the title model upgrades (the server files it titleAuto):
    // the prompt's first line, so the task reads sensibly until then.
    const title = prompt.split("\n")[0]!.slice(0, TITLE_CHARS);
    const result = await launch(prompt, draft.picked, {
      title,
      categoryId: CONVERSATIONS_CATEGORY_ID,
    });
    // Unreachable: the send button is disabled while launching is
    // unavailable, and a subtree's transport is fixed.
    if (result.kind === "unavailable") throw new Error(result.message);
    clearDraft();
  };

  // A disabled button shows no tooltip, so a host without the computer says
  // why under the field — it is the page's one action.
  const unavailable = availability.available ? null : availability.message;

  return (
    <>
      <ComposerField
        value={draft.text}
        onChange={(text) => setDraft((d) => ({ ...d, text }))}
        onSubmit={() => void send()}
        submitMode="enter"
        placeholder="What should an agent do?"
        autoFocus
        minRows={2}
        maxHeight="16rem"
        namespace="agent-manager-home-prompt"
        barStart={
          <LaunchOptionPills
            side="start"
            values={options}
            onChange={setPicked}
            disabled={false}
          />
        }
        barEnd={
          <>
            <LaunchOptionPills
              side="end"
              values={options}
              onChange={setPicked}
              disabled={false}
            />
            {/* Round, and filled only once there is something to send — empty,
              it is the disabled glyph, so the field reads as waiting for words.
              One rung above the bar's compact density: it is the field's one
              action, so it reads larger than the pills beside it. */}
            <ControlSizeProvider size="md">
              <IconButton
                icon={sendIcon}
                label="Start agent"
                tooltip={blockReason ?? undefined}
                shortcut="enter"
                variant="default"
                className="rounded-full"
                disabled={!canSend}
                onClick={send}
              />
            </ControlSizeProvider>
          </>
        }
      />
      {unavailable !== null ? (
        <Text as="div" variant="caption" tone="muted" className="px-2xs">
          {unavailable}
        </Text>
      ) : null}
    </>
  );
}

function Counts({
  needsYou,
  running,
  total,
}: {
  needsYou: number;
  running: number;
  total: number;
}) {
  return (
    <Line className="gap-lg px-2xs">
      <Count dot={NEEDS_YOU_DOT} label={`${needsYou} need you`} />
      <Count dot={RUNNING_DOT} label={`${running} running`} />
      <Fill />
      {/* The all-time total sits apart, at the line's far end: context, not status. */}
      <Text variant="caption" tone="faint" className="tabular-nums">
        {total.toLocaleString()} total
      </Text>
    </Line>
  );
}

function Count({ dot, label }: { dot: string; label: string }) {
  return (
    <Line className="gap-xs">
      <StatusDot colorClass={dot} />
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </Line>
  );
}
