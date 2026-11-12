import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const lockIcon = symbol("lock");

interface CommandPermissionsPayload {
  type: "command_permissions";
  allowedTools: string[];
}

export function CommandPermissionsView({ event }: AttachmentRendererProps) {
  const att = event.attachment as CommandPermissionsPayload;
  const tools = att.allowedTools ?? [];

  return (
    <CollapsibleCard
      icon={<Icon icon={lockIcon} className="size-3.5" />}
      label="Command permissions"
      note={`· ${tools.length} tool${tools.length === 1 ? "" : "s"}`}
    >
      {tools.length === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No permissions granted.
        </Text>
      ) : (
        <Stack as="div" gap="2xs" className="font-mono">
          {tools.map((tool) => (
            <Text
              as="p"
              variant="caption"
              key={tool}
              className="text-muted-foreground"
            >
              {tool}
            </Text>
          ))}
        </Stack>
      )}
    </CollapsibleCard>
  );
}
