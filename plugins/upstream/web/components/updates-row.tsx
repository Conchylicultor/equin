import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { renderPrompt } from "@plugins/tasks/plugins/automations/core";
import { MANDATE_PUSH_POLICY_TEXT } from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";
import { ConversationStatusChip } from "@plugins/conversations/plugins/conversation-view/plugins/status/web";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";
import { upstreamMergeConfig, UPSTREAM_CATEGORY_ID } from "../../shared/config";
import {
  upstreamMergeTitle,
  upstreamMergeVariables,
} from "../../shared/merge-prompt";
import { upstreamReminderConfig } from "../../shared/reminder-config";
import { upstreamReleaseSubject } from "../../shared/subject";
import { useUpdatesView } from "../internal/use-updates";
import { updateSpan } from "../internal/updates-view";

const conversationIcon = symbol("chat-bubble");
const remindersOnIcon = symbol("notifications-active");
const remindersOffIcon = symbol("notifications-off");

const SEND_LABEL = "Send agent to update";
const SEND_TOOLTIP =
  "Launch an agent in a new worktree to merge main changes with your app";

/**
 * The updates row's remedy while it is out of date: "Send agent to update",
 * the standard launch popover (pre-prompt, model, effort, extra instructions).
 * The agent is briefed with the Upstream merges prompt (the user's edited one,
 * when they edited it) and the user's words, filed about the release
 * (`upstreamReleaseSubject`) so a second launch — or the automation — reuses
 * its task. Nothing while an update is already in progress: the glance shows
 * that one instead.
 */
export function SendAgentToUpdate() {
  const view = useUpdatesView();
  const merge = useConfigResult(upstreamMergeConfig);
  if (view.kind !== "out-of-date") return null;
  switch (merge.status) {
    case "loading":
      return (
        <Button variant="secondary" disabled>
          {SEND_LABEL}
        </Button>
      );
    case "error":
      return (
        <ResourceErrorInline
          error={merge.error}
          refetch={merge.refetch}
          variant="icon"
          subject="the Upstream merges prompt"
        />
      );
    case "ready":
      return (
        <SendPopover
          current={view.current}
          latest={view.latest}
          template={merge.data.prompt}
        />
      );
  }
}

function SendPopover({
  current,
  latest,
  template,
}: {
  current: string | null;
  latest: string;
  template: string;
}) {
  const updates = { current, latest, url: null };
  return (
    <LaunchAgentPopover
      draftKey={`upstream-update:${latest}`}
      align="end"
      trigger={
        <Button variant="secondary" tooltip={SEND_TOOLTIP}>
          {SEND_LABEL}
        </Button>
      }
      title={`Update ${PRODUCT_NAME} ${updateSpan(current, latest)}`}
      description={`The agent merges ${PRODUCT_NAME} ${releaseVersion(latest)} into a new worktree, resolves any conflict with your changes, builds and checks the app. You land it from its conversation.`}
      placeholder="Add instructions for the agent…"
      getRequest={(userText) => {
        const prompt = renderPrompt(template, {
          ...upstreamMergeVariables(updates),
          pushPolicy: MANDATE_PUSH_POLICY_TEXT["on-request"],
        });
        if (!prompt.ok)
          throw new Error(
            `The Upstream merges prompt uses ${prompt.unknown.map((n) => `{{${n}}}`).join(", ")}, which an update does not fill — fix it in Automations → Upstream merges.`,
          );
        const extra = userText.trim();
        return {
          prompt:
            extra.length === 0
              ? prompt.text
              : `${prompt.text}\n\nThe user adds:\n${extra}`,
          title: upstreamMergeTitle(updates),
          categoryId: UPSTREAM_CATEGORY_ID,
          subject: upstreamReleaseSubject(latest),
          filedFrom: asPluginId("upstream"),
        };
      }}
    />
  );
}

/**
 * The glance while an update is in progress: its conversation, linked, with
 * that conversation's OWN status chip — the row never restates the agent's
 * state in words of its own.
 */
export function UpdateGlance() {
  const view = useUpdatesView();
  const appLinkProps = useAppLinkProps();
  if (view.kind !== "in-progress") return null;
  if (view.run === null)
    return (
      <Text variant="caption" tone="muted">
        Filed — no agent started yet
      </Text>
    );
  const convId = view.run.id;
  return (
    <Line className="gap-sm">
      <Fill>
        <Button
          {...appLinkProps(conversationRoute.link(agentManagerApp, { convId }))}
          variant="ghost"
          className="gap-xs"
        >
          <Icon icon={conversationIcon} className="size-3.5" />
          <Text variant="caption">
            Update {PRODUCT_NAME} to {releaseVersion(view.latest)}
          </Text>
        </Button>
      </Fill>
      <ConversationStatusChip convId={convId} />
    </Line>
  );
}

/**
 * The bell on the row, in every state: whether this clone reminds its user
 * of a new release. The tooltip says what a click does.
 */
export function ReminderBell() {
  const config = useConfigResult(upstreamReminderConfig);
  const setConfig = useSetConfig(upstreamReminderConfig);
  if (config.status === "loading")
    // Not known yet: a disabled bell, never a guessed on/off.
    return (
      <IconButton icon={remindersOnIcon} label="Update reminders" disabled />
    );
  if (config.status === "error")
    return (
      <ResourceErrorInline
        error={config.error}
        refetch={config.refetch}
        variant="icon"
        subject="the update reminders setting"
      />
    );
  const enabled = config.data.enabled;
  return (
    <IconButton
      icon={enabled ? remindersOnIcon : remindersOffIcon}
      label={enabled ? "Stop update reminders" : "Get update reminders"}
      tooltip={
        enabled
          ? "Reminders on — click to stop them"
          : "Reminders off — click to get them again"
      }
      onClick={() => setConfig("enabled", !enabled)}
    />
  );
}
