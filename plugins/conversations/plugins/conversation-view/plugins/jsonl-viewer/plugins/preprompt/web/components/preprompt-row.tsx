import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const campaignIcon = symbol("campaign");

type PrepromptEvent = Extract<JsonlEvent, { kind: "preprompt" }>;

export function PrepromptRow({ event }: { event: JsonlEvent }) {
  const e = event as PrepromptEvent;

  return (
    <CollapsibleCard
      className="border-primary/30 bg-primary/5"
      icon={<Icon icon={campaignIcon} className="size-3.5 text-primary-text" />}
      label={<span className="text-primary-text">Instructions</span>}
    >
      <Text
        as="div"
        variant="caption"
        className="whitespace-pre-wrap break-words text-muted-foreground"
      >
        {e.text}
      </Text>
    </CollapsibleCard>
  );
}
