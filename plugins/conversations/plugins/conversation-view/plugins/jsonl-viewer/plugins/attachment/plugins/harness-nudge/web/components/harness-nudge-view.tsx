import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const campaignIcon = symbol("campaign");

interface HarnessNudgePayload {
  type: string;
  text?: string;
}

/** Names which nudge this is. Unmapped subtypes fall back to the humanised
 *  subtype, so a nudge the harness adds still reads as a sentence rather than
 *  as an identifier. */
const NUDGE_LABEL: Record<string, string> = {
  batching_reminder_sent: "Batching reminder",
  silent_turn_reminder: "Check-in reminder",
};

function labelFor(subtype: string): string {
  const known = NUDGE_LABEL[subtype];
  if (known) return known;
  const words = subtype.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The harness slipping the agent a coaching note mid-session — batch your tool
 * calls, say something so the user knows you're alive. It is not the agent's
 * turn and not the user's, and it is never the point of the conversation, so it
 * renders as a collapsed card: the closed row names which nudge, and opening it
 * shows the note's full text.
 */
export function HarnessNudgeView({ event }: AttachmentRendererProps) {
  const att = event.attachment as HarnessNudgePayload;
  if (!att.text) {
    throw new Error(`${event.subtype} attachment carries no \`text\``);
  }

  return (
    <CollapsibleCard
      icon={<Icon icon={campaignIcon} className="size-3.5" />}
      label={labelFor(event.subtype)}
    >
      <Text
        as="p"
        variant="caption"
        className="whitespace-pre-wrap break-words text-muted-foreground"
      >
        {att.text}
      </Text>
    </CollapsibleCard>
  );
}
