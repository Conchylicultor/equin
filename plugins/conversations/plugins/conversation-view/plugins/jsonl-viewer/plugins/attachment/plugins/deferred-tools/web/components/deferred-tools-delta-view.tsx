import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const buildIcon = symbol("build");

interface DeferredToolsDeltaPayload {
  type: "deferred_tools_delta";
  addedNames: string[];
  addedLines: string[];
  removedNames: string[];
}

export function DeferredToolsDeltaView({ event }: AttachmentRendererProps) {
  const att = event.attachment as DeferredToolsDeltaPayload;
  const added = att.addedNames?.length ?? 0;
  const removed = att.removedNames?.length ?? 0;

  const counts = [
    added > 0 ? `+${added}` : null,
    removed > 0 ? `−${removed}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <CollapsibleCard
      icon={<Icon icon={buildIcon} className="size-3.5" />}
      label="Deferred tools"
      note={counts ? `· ${counts}` : "· no changes"}
    >
      {added === 0 && removed === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No changes.
        </Text>
      ) : (
        <Stack as="div" gap="2xs" className="font-mono">
          {att.addedNames?.map((name) => (
            <Text
              as="p"
              variant="caption"
              key={name}
              className="text-muted-foreground"
            >
              <span className="text-success">+</span> {name}
            </Text>
          ))}
          {att.removedNames?.map((name) => (
            <Text
              as="p"
              variant="caption"
              key={name}
              className="text-muted-foreground line-through"
            >
              <span className="text-destructive no-underline">−</span> {name}
            </Text>
          ))}
        </Stack>
      )}
    </CollapsibleCard>
  );
}
