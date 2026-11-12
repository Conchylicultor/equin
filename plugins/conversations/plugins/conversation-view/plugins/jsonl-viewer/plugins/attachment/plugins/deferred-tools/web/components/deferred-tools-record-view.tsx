import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const buildIcon = symbol("build");

interface DeferredToolsRecordPayload {
  type: "deferred_tools_record";
  entries?: { name: string; description?: string }[];
}

/**
 * The full deferred-tool roster, as opposed to the delta's "these two just
 * appeared". Same subject, so it wears the same label — only the note tells
 * them apart (a count here, `+n −n` there).
 *
 * The body lists NAMES only. Each entry's `description` is the tool's entire
 * schema prose — hundreds of lines apiece — and pasting sixteen of them into
 * the transcript would bury the conversation for a fact the reader almost
 * never needs. The row's raw-JSON action is where the full entries live.
 */
export function DeferredToolsRecordView({ event }: AttachmentRendererProps) {
  const att = event.attachment as DeferredToolsRecordPayload;
  if (!Array.isArray(att.entries)) {
    throw new Error("deferred_tools_record attachment carries no `entries`");
  }
  const entries = att.entries;

  return (
    <CollapsibleCard
      icon={<Icon icon={buildIcon} className="size-3.5" />}
      label="Deferred tools"
      note={`· ${entries.length} ${entries.length === 1 ? "tool" : "tools"}`}
    >
      {entries.length === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No tools.
        </Text>
      ) : (
        <Scroll className="max-h-64">
          <Stack as="div" gap="2xs" className="font-mono">
            {entries.map((entry) => (
              <Text
                as="p"
                variant="caption"
                key={entry.name}
                className="break-all text-muted-foreground"
              >
                {entry.name}
              </Text>
            ))}
          </Stack>
        </Scroll>
      )}
    </CollapsibleCard>
  );
}
