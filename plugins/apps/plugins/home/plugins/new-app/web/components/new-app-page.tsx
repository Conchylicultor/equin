import { useState } from "react";
import { z } from "zod";
import { useTaskLaunch } from "@plugins/primitives/plugins/launch/web";
import {
  LaunchOptionPills,
  type LaunchOptionValues,
} from "@plugins/tasks/plugins/launch-options/web";
import { useClaudeCodeLaunchBlock } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { ComposerField } from "@plugins/primitives/plugins/text-editor/plugins/composer/web";
import {
  DEFAULT_DRAFT_TTL,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  Button,
  ControlSizeProvider,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { homeRootPane } from "@plugins/apps/plugins/home/plugins/shell/web";
import { APPS_CATEGORY_ID } from "@plugins/apps/plugins/home/core";
import { APP_IDEAS, dealIdeas } from "../internal/ideas";
import { newAppPrompt } from "../internal/prompt";

const backIcon = symbol("arrow-back");
const shuffleIcon = symbol("shuffle");

/** What the user has typed and picked, and not created yet. */
type NewAppDraft = {
  text: string;
  /** Only the launch options the user changed; the rest read through to defaults. */
  picked: LaunchOptionValues;
};

const newAppDraftStore = defineStore<NewAppDraft>({
  owner: "home.new-app",
  label: "New app drafts",
  area: "local",
  cap: "64 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.object({
    text: z.string(),
    picked: z.record(z.string(), z.unknown()),
  }),
});

/** How long the placeholder task title may be — the title model replaces it. */
const TITLE_CHARS = 80;

/**
 * Home's New app screen: ONE prompt — the standard composer field, with the
 * launch options on its bar and Create at its end — under the steps every new
 * app goes through (Prototype → App), and a random hand of starting ideas
 * while the field is empty. Create files a task under the Apps category and
 * opens its conversation in the Agent Manager; the agent picks the app's name,
 * icon and colour itself.
 */
export function NewAppPage() {
  const openPane = useOpenPane();
  const [draft, setDraft, clearDraft] = useDraft(newAppDraftStore, {
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
  const [ideas, setIdeas] = useState(() => dealIdeas());
  // No computer behind this subtree, or Claude Code missing or signed out:
  // Create says why rather than filing a launch that cannot run.
  const claudeBlock = useClaudeCodeLaunchBlock();
  const blockReason = availability.available
    ? claudeBlock
    : availability.message;
  const description = draft.text.trim();
  const canCreate = description !== "" && blockReason === null;

  const create = async () => {
    if (!canCreate) return;
    const result = await launch(newAppPrompt(description), draft.picked, {
      // A placeholder the title model upgrades: the description's first line.
      title: description.split("\n")[0]!.slice(0, TITLE_CHARS),
      categoryId: APPS_CATEGORY_ID,
    });
    // Unreachable: Create is disabled while launching is unavailable.
    if (result.kind === "unavailable") throw new Error(result.message);
    clearDraft();
  };

  return (
    // A size container, so the body's top offset is a share of the PANE's
    // height (`cqh`), not the viewport's.
    <Scroll className="h-full bg-background [container-type:size]">
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- the mock's page frame: 18px above, 20px gutters, 40px below */}
      <Stack gap="none" className="min-h-full px-[20px] pt-[18px] pb-[40px]">
        <Line>
          <Button
            variant="ghost"
            className="text-faint-foreground"
            {...openPane.link(homeRootPane, {}, { mode: "root" })}
          >
            <Icon icon={backIcon} />
            Apps
          </Button>
        </Line>
        <Stack
          gap="xl"
          // eslint-disable-next-line spacing/no-adhoc-spacing -- the column sits 12% of the pane down (never under 40px), 680px wide: the mock's geometry, above the spacing ramp
          className="mx-auto w-[min(680px,100%)] pt-[max(40px,12cqh)]"
        >
          <Stack gap="sm">
            <Text as="h1" variant="display" className="tracking-tight">
              New app
            </Text>
            <StageTrack />
          </Stack>
          <Stack gap="lg">
            <Stack gap="xs">
              <ComposerField
                value={draft.text}
                onChange={(text) => setDraft((d) => ({ ...d, text }))}
                onSubmit={() => void create()}
                submitMode="cmd-enter"
                placeholder="Describe the app you want"
                autoFocus
                minRows={5}
                maxHeight="20rem"
                namespace="home-new-app"
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
                    {/* The field's one action, a rung above the bar's pills. */}
                    <ControlSizeProvider size="md">
                      <Button
                        disabled={!canCreate}
                        tooltip={blockReason ?? undefined}
                        onClick={create}
                      >
                        Create
                        <Text variant="caption" className="opacity-50">
                          {formatShortcutLabel("mod+enter")}
                        </Text>
                      </Button>
                    </ControlSizeProvider>
                  </>
                }
              />
              {!availability.available ? (
                <Text
                  as="div"
                  variant="caption"
                  tone="muted"
                  className="px-2xs"
                >
                  {availability.message}
                </Text>
              ) : null}
            </Stack>
            {description === "" ? (
              <Center axis="horizontal">
                <ControlSizeProvider size="sm">
                  <Cluster gap="sm" justify="center">
                    {ideas.map((i) => (
                      <Button
                        key={APP_IDEAS[i]!.label}
                        variant="outline"
                        shape="pill"
                        className="font-normal text-muted-foreground"
                        onClick={() =>
                          setDraft((d) => ({ ...d, text: APP_IDEAS[i]!.text }))
                        }
                      >
                        {APP_IDEAS[i]!.label}
                      </Button>
                    ))}
                    <IconButton
                      icon={shuffleIcon}
                      label="Other ideas"
                      variant="outline"
                      className="rounded-full text-muted-foreground"
                      onClick={() => setIdeas((prev) => dealIdeas(prev))}
                    />
                  </Cluster>
                </ControlSizeProvider>
              </Center>
            ) : null}
          </Stack>
        </Stack>
      </Stack>
    </Scroll>
  );
}

/** The steps every new app goes through; this screen is the first. */
const STAGES = [
  {
    label: "Prototype",
    tip: "A clickable mockup of the app, ready in minutes — try it and ask for changes until it feels right.",
  },
  {
    label: "App",
    tip: "The agent builds it for real, and it joins your apps.",
  },
] as const;

function StageTrack() {
  return (
    <Line className="gap-sm">
      {STAGES.map((stage, i) => (
        <Line key={stage.label} className="gap-sm">
          {i > 0 ? (
            <span aria-hidden className="block h-px w-6 bg-input" />
          ) : null}
          <WithTooltip content={stage.tip}>
            <Line
              className={
                i === 0
                  ? "gap-xs text-foreground"
                  : "gap-xs text-faint-foreground"
              }
            >
              <Center
                className={
                  i === 0
                    ? "size-[18px] rounded-full bg-foreground text-background"
                    : "size-[18px] rounded-full border border-input"
                }
              >
                <Text variant="caption" className="text-2xs font-semibold">
                  {i + 1}
                </Text>
              </Center>
              <Text variant="caption">{stage.label}</Text>
            </Line>
          </WithTooltip>
        </Line>
      ))}
    </Line>
  );
}
