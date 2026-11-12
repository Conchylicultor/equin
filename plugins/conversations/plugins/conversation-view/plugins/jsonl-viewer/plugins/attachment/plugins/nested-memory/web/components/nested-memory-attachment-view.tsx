import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const memoryIcon = symbol("memory");

interface NestedMemoryPayload {
  type: "nested_memory";
  path: string;
  displayPath: string;
  content: {
    path: string;
    type: string;
    content: string;
  };
}

export function NestedMemoryAttachmentView({ event }: AttachmentRendererProps) {
  const att = event.attachment as NestedMemoryPayload;

  return (
    <CollapsibleCard
      icon={<Icon icon={memoryIcon} className="size-3.5" />}
      label="Memory"
      aside={<FilePath filePath={att.path} />}
    >
      <Scroll className="max-h-64">
        <Text
          as="pre"
          variant="caption"
          className="whitespace-pre-wrap break-words font-mono text-muted-foreground"
        >
          {att.content?.content ?? JSON.stringify(att, null, 2)}
        </Text>
      </Scroll>
    </CollapsibleCard>
  );
}
