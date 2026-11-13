import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { CONFIG_CATEGORY_ID } from "@plugins/config_v2/plugins/settings/core";
import type { ConfigConflictContext } from "@plugins/config_v2/plugins/settings/web";
import {
  buildConflictPrompt,
  describeConflict,
} from "../internal/build-prompt";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoAwesomeIcon = symbol("auto-awesome");

/**
 * "Ask an agent" inside a config conflict banner: the standard launch popover,
 * with the conflict already written out as the agent's first turn. The user
 * reads what the agent is being handed, types any extra context, picks the
 * model, and launches — same surface as the crash Fix and build-failure
 * buttons, so "launch an agent about this" looks the same everywhere.
 *
 * The launch files a task under the Config category and starts it; the
 * conversation runs in the background, and the bell's "Conversation started"
 * entry is what carries the user to it.
 */
export function ConflictAgentButton({
  conflict,
}: {
  conflict: ConfigConflictContext;
}) {
  return (
    <LaunchAgentPopover
      draftKey={`config-conflict:${conflict.storePath}:${conflict.scopeId ?? ""}:${conflict.kind}`}
      trigger={
        <Button variant="ghost" className={conflict.actionClassName}>
          <Icon icon={autoAwesomeIcon} className="size-3.5" />
          Ask an agent
        </Button>
      }
      title="Resolve this config conflict"
      description={describeConflict(conflict)}
      placeholder="Extra context (optional) — e.g. why you set these values…"
      align="end"
      getRequest={(userText) => {
        const extra = userText.trim();
        const prompt = extra
          ? `${buildConflictPrompt(conflict)}\n\n## Context\n\n${extra}`
          : buildConflictPrompt(conflict);
        return {
          prompt,
          categoryId: CONFIG_CATEGORY_ID,
          filedFrom: asPluginId("config_v2.settings.conflict-agent"),
        };
      }}
    />
  );
}
