import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const replayIcon = symbol("replay");

type MetaPromptEvent = Extract<JsonlEvent, { kind: "meta-prompt" }>;

export function MetaPromptRow({ event }: { event: JsonlEvent }) {
  const e = event as MetaPromptEvent;

  // Sibling of the preprompt "Instructions" card on the canonical CollapsibleCard
  // chrome. Neutral (no color accent) with only a dashed border, preserving the
  // "harness, not human" cue while keeping primary as the single Instructions callout.
  return (
    <CollapsibleCard
      className="border-dashed"
      icon={<Icon icon={replayIcon} className="size-3.5" />}
      label="Resumed by harness"
      note={e.source ? `· ${e.source}` : undefined}
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
