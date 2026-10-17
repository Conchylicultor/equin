import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-view/web";
import { pluginViewPane } from "@plugins/plugin-meta/plugins/plugin-view/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { pluginConvSidePane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const widgetsIcon = symbol("widgets");

/**
 * Pure renderer, reachable ONLY on a claim — `value` is a resolved plugin, so
 * there is no "unknown plugin" branch here and no hand-rolled `<code>` fallback.
 * When the token does not resolve, `usePluginClaim` declines and the host's
 * arbitration chain owns what renders instead.
 */
export function PluginLinkChip({
  content,
  value,
}: {
  content: string;
  value: PluginNode;
}) {
  const convId = conversationPane.useRouteEntry()?.params.convId ?? null;
  const openPane = useOpenPane();
  const resolvedId = value.id;

  return (
    <LinkChip
      activation={
        convId
          ? openPane.to(
              pluginConvSidePane,
              { pluginId: resolvedId },
              { mode: "push" },
            )
          : openPane.to(
              pluginViewPane,
              { pluginId: resolvedId },
              { mode: "push" },
            )
      }
      tooltip={value.description ?? resolvedId}
      leading={<Icon icon={widgetsIcon} className="text-muted-foreground" />}
      mono
    >
      {content}
    </LinkChip>
  );
}
