import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import type { ConversationItemConv } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useConversationPreprompt } from "../internal/hooks";
import { PrepromptIcon } from "./preprompt-icon";

// Sidebar row marker surfacing the preprompt a conversation was launched with,
// as a small muted glyph (mirrors the op-status chip's placement). Rendered for
// every conversation that has a preprompt — PrepromptIcon resolves the icon
// live and falls back to a default glyph, so the marker is always visible.
// Conversations launched without any preprompt stay unadorned.
export function PrepromptListIcon({ conv }: { conv: ConversationItemConv }) {
  const result = useConversationPreprompt(conv.id);
  // Nothing while loading, nothing when no preprompt was recorded.
  if (result.status === "loading") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the preprompt"
        error={result.error}
        refetch={result.refetch}
      />
    );
  if (!result.found) return null;
  const record = result.row;
  return (
    <WithTooltip content={`Preprompt: ${record.title}`}>
      <Inline as="span" gap="none" className="text-muted-foreground">
        <PrepromptIcon record={record} />
      </Inline>
    </WithTooltip>
  );
}
