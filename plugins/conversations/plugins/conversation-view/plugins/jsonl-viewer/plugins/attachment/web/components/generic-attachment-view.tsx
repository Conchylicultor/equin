import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { AttachmentRendererProps } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const helpIcon = symbol("help");

export function GenericAttachmentView({ event }: AttachmentRendererProps) {
  return (
    <CollapsibleCard
      icon={<Icon icon={helpIcon} className="size-3.5" />}
      label={`attachment:${event.subtype}`}
    >
      <Text
        as="pre"
        variant="caption"
        className="whitespace-pre-wrap break-words font-mono text-muted-foreground"
      >
        {JSON.stringify(event.attachment, null, 2)}
      </Text>
    </CollapsibleCard>
  );
}
