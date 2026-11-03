import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useState } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { ConfigPopoverHeader } from "@plugins/config_v2/plugins/config-link/web";
import { prepromptsConfig } from "@plugins/conversations/plugins/preprompts/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationPreprompt } from "../internal/hooks";
import { PrepromptIcon } from "./preprompt-icon";

// Header chip surfacing the preprompt the conversation's task was launched
// with. Sourced entirely from the conversation's recorded snapshot — clicking
// reveals the full instruction text in a scrollable popover.
export function PrepromptChip() {
  const { convId } = conversationPane.useParams();
  const result = useConversationPreprompt(convId);
  const [open, setOpen] = useState(false);
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
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Badge
          as="button"
          className="hover:opacity-80"
          aria-label={`Preprompt: ${record.title}`}
          icon={<PrepromptIcon record={record} />}
        >
          <span className="max-w-32 truncate">{record.title}</span>
        </Badge>
      }
      width="xl"
      padding="sm"
    >
      <ConfigPopoverHeader
        label="Preprompt instructions"
        descriptor={prepromptsConfig}
      />
      <Scroll className="max-h-80">
        <Text
          as="div"
          variant="caption"
          className="whitespace-pre-wrap break-words px-xs text-muted-foreground"
          aria-label="Preprompt instructions"
        >
          {record.text}
        </Text>
      </Scroll>
    </InlinePopover>
  );
}
