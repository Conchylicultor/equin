import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const extensionIcon = symbol("extension");

interface McpInstructionsDeltaPayload {
  type: "mcp_instructions_delta";
  addedNames?: string[];
  addedBlocks?: string[];
  removedNames?: string[];
}

/**
 * An MCP server's instructions entering (or leaving) the agent's context
 * mid-session — the sibling of the deferred-tools delta, one layer up: that one
 * says which of a server's TOOLS appeared, this says which server's standing
 * INSTRUCTIONS did. They wear the same `+ name` / `− name` grammar and the same
 * `(+n −n)` note so the pair reads as the family it is.
 *
 * The added blocks are a section of their own rather than folded in beside the
 * names they arrived with. `addedBlocks` happens to line up positionally with
 * `addedNames` in the samples, but nothing in the payload says it must, and a
 * block silently attributed to the wrong server would be worse than one shown
 * on its own.
 */
export function McpInstructionsDeltaView({ event }: AttachmentRendererProps) {
  const att = event.attachment as McpInstructionsDeltaPayload;
  const addedNames = att.addedNames ?? [];
  const removedNames = att.removedNames ?? [];
  const addedBlocks = att.addedBlocks ?? [];

  const counts = [
    addedNames.length > 0 ? `+${addedNames.length}` : null,
    removedNames.length > 0 ? `−${removedNames.length}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const empty =
    addedNames.length === 0 &&
    removedNames.length === 0 &&
    addedBlocks.length === 0;

  return (
    <CollapsibleCard
      icon={<Icon icon={extensionIcon} className="size-3.5" />}
      label="MCP instructions"
      note={counts ? `· ${counts}` : "· no changes"}
    >
      {empty ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No changes.
        </Text>
      ) : (
        <Stack as="div" gap="xs">
          <Stack as="div" gap="2xs" className="font-mono">
            {addedNames.map((name) => (
              <Text
                as="p"
                variant="caption"
                key={name}
                className="text-muted-foreground"
              >
                <span className="text-success">+</span> {name}
              </Text>
            ))}
            {removedNames.map((name) => (
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
          {addedBlocks.length > 0 && (
            <Scroll className="max-h-64">
              <Stack as="div" gap="xs">
                {addedBlocks.map((block, i) => (
                  <Text
                    as="pre"
                    variant="caption"
                    // Blocks carry no id of their own, and two servers can ship
                    // byte-identical instructions, so position is the only key.
                    key={i}
                    className="whitespace-pre-wrap break-words font-mono text-muted-foreground"
                  >
                    {block}
                  </Text>
                ))}
              </Stack>
            </Scroll>
          )}
        </Stack>
      )}
    </CollapsibleCard>
  );
}
