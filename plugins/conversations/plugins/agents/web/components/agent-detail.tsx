import { statusDotPaintClass } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useCallback, useMemo, useState } from "react";
import {
  foldResource,
  ResourceView,
} from "@plugins/primitives/plugins/live-state/web";
import { mapRow, useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import {
  Avatar,
  AvatarPicker,
  DEFAULT_AGENT_AVATAR,
} from "@plugins/primitives/plugins/avatar/web";
import { CONV_STATUS_DOT } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import {
  fetchEndpoint,
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import {
  launchAgent,
  updateAgent,
} from "@plugins/conversations/plugins/agents/core";
import { ModelSelect } from "@plugins/conversations/plugins/model-provider/web";
import type { ModelChoice } from "@plugins/conversations/plugins/model-provider/core";
import { agentLaunchRows, agentRows } from "../../core";
import type { Agent } from "../../core";
import { AgentLaunches } from "./agent-launches";
import { symbol, type SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const playArrowIcon = symbol("play-arrow");

type Patch = Partial<{
  name: string;
  prompt: string | null;
  model: ModelChoice | null;
  icon: SavedSymbolName | null;
  iconColor: string | null;
}>;

async function patchAgent(id: string, patch: Patch) {
  await fetchEndpoint(updateAgent, { id }, { body: patch });
}

export function AgentDetail({ agentId }: { agentId: string }) {
  const agentResult = mapRow(useLiveRow(agentRows, agentId), (row) => row);
  return (
    <ResourceView resource={agentResult} fallback={<Loading variant="text" />}>
      {(agent) => {
        // Not in the roster: the pane's resolve guard answers that (the side
        // pane has none, and keeps the loading state).
        if (!agent) return <Loading />;
        return (
          <AgentDetailInner key={agentId} agentId={agentId} agent={agent} />
        );
      }}
    </ResourceView>
  );
}

function AgentDetailInner({
  agentId,
  agent,
}: {
  agentId: string;
  agent: Agent;
}) {
  const launchesQ = useLive(agentLaunchRows);
  const [model, setModel] = useState<ModelChoice | null>(agent.model);
  const [launching, setLaunching] = useState(false);
  // No computer behind this subtree (an in-browser server): launching cannot
  // be asked at all, so the pane says why instead of offering it.
  const launchAvailability = useMachineAvailability(launchAgent);
  const unavailable = launchAvailability.available
    ? null
    : launchAvailability.message;
  const fetchMachineEndpoint = useFetchEndpoint();

  const save = useCallback(
    async (patch: Patch) => {
      await patchAgent(agentId, patch);
    },
    [agentId],
  );

  // The avatar's status dot. A failed launches read draws no dot, the same as
  // loading: the dot is decoration on the avatar, and the Attempts section
  // below renders that same read's failure where it can be retried.
  const latestStatus = useMemo(
    () =>
      foldResource(launchesQ, {
        loading: () => null,
        error: () => null,
        ready: (launches) => {
          const latest = launches
            .filter((l) => l.agentId === agentId)
            .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
          return latest?.latestConversationStatus ?? null;
        },
      }),
    [launchesQ, agentId],
  );

  const nameField = useEditableField({
    value: agent.name ?? "",
    onSave: (v) => save({ name: v.trim() || "Untitled" }),
  });
  const promptField = useEditableField({
    value: agent.prompt ?? "",
    onSave: (v) => save({ prompt: v }),
  });

  const onModelChange = async (newModel: ModelChoice | null) => {
    setModel(newModel);
    await save({ model: newModel });
  };

  const launch = async () => {
    if (!agent.prompt) return;
    if (launching || unavailable !== null) return;
    setLaunching(true);
    try {
      await promptField.flush();
      const result = await fetchMachineEndpoint(
        launchAgent,
        { id: agentId },
        { body: {} },
      );
      // Unreachable: Launch is disabled while launching is unavailable, and a
      // subtree's transport is fixed.
      if (result.kind === "unavailable") throw new Error(result.message);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Inset pad="xl">
      <Stack gap="lg">
        <Stack direction="row" gap="md" align="center">
          <AvatarPicker
            value={{
              icon: agent.icon ?? DEFAULT_AGENT_AVATAR.icon,
              color: agent.iconColor ?? DEFAULT_AGENT_AVATAR.color,
            }}
            onChange={(next) =>
              save({ icon: next.icon, iconColor: next.color })
            }
            triggerLabel="Pick agent avatar"
          >
            {/* Hero avatar (48px) next to the name input — the comfortable header
              region declares `lg` once; the avatar tracks it. */}
            <ControlSizeProvider size="lg">
              <Avatar
                icon={agent.icon ?? DEFAULT_AGENT_AVATAR.icon}
                color={agent.iconColor ?? DEFAULT_AGENT_AVATAR.color}
                statusDot={
                  latestStatus
                    ? statusDotPaintClass(CONV_STATUS_DOT[latestStatus])
                    : null
                }
                fallbackKey={agent.id}
              />
            </ControlSizeProvider>
          </AvatarPicker>
          <input
            value={nameField.value}
            onChange={(e) => nameField.onChange(e.target.value)}
            onFocus={nameField.onFocus}
            onBlur={nameField.onBlur}
            placeholder="Untitled"
            className="placeholder:text-muted-foreground w-full bg-transparent text-title outline-none focus:ring-0"
          />
        </Stack>
        <Stack gap="xs">
          <SectionLabel as="label">Model</SectionLabel>
          <ModelSelect
            value={model}
            onChange={(m) => void onModelChange(m)}
            offLabel="Default"
            ariaLabel="Model"
          />
        </Stack>
        <Stack gap="xs">
          <SectionLabel as="label">Prompt</SectionLabel>
          <div
            onFocus={promptField.onFocus}
            onBlur={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null))
                return;
              promptField.onBlur();
            }}
          >
            <TextEditor
              value={promptField.value}
              onChange={promptField.onChange}
              placeholder="Instructions the agent runs with…"
              minRows={12}
              namespace={`agent-prompt-${agentId}`}
            />
          </div>
        </Stack>
        {unavailable !== null && (
          <Text as="div" variant="caption" tone="muted">
            {unavailable}
          </Text>
        )}
        <Stack gap="none" direction="row" justify="end">
          <Button
            onClick={launch}
            loading={launching}
            disabled={unavailable !== null || !promptField.value.trim()}
            className="gap-xs"
          >
            <Icon icon={playArrowIcon} className="size-4" />
            Launch
          </Button>
        </Stack>
        <AgentLaunches agentId={agentId} />
      </Stack>
    </Inset>
  );
}
