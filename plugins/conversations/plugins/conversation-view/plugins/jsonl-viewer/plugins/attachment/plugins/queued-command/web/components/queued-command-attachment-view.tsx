import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { parseStructuredTag } from "../internal/parse-structured-tag";
import { StructuredTagCard } from "./structured-tag-card";

const scheduleIcon = symbol("schedule");

interface QueuedCommandPayload {
  type: "queued_command";
  prompt: unknown;
  commandMode?: string;
}

// A `queued_command` the CLI delivered into a running turn. A human prompt
// (commandMode "prompt") never reaches this view: the transcript parser turns
// it into the user's own message. What is left is a harness control message
// (e.g. a `<task-notification>` block): rendered as a titled key/value card
// when it parses as one tag block — field-agnostic, so new fields surface on
// their own — else as its raw text.
export function QueuedCommandAttachmentView({ event }: AttachmentRendererProps) {
  const att = event.attachment as QueuedCommandPayload;
  const prompt =
    typeof att.prompt === "string" ? att.prompt : JSON.stringify(att.prompt);
  const structured = parseStructuredTag(prompt);

  if (structured) {
    return <StructuredTagCard structured={structured} />;
  }

  return (
    <CollapsibleCard
      defaultOpen
      icon={<Icon icon={scheduleIcon} className="size-3.5" />}
      label="Queued command"
    >
      <Text
        as="div"
        variant="caption"
        className="whitespace-pre-wrap break-words font-mono text-foreground"
      >
        {prompt}
      </Text>
    </CollapsibleCard>
  );
}
