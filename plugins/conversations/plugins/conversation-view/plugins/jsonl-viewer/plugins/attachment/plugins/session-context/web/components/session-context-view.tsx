import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const layersIcon = symbol("layers");

interface SessionContextPayload {
  type: "session_context";
  /** An OPEN map: the harness decides which blocks it injects, and adds more
   *  over time. Never narrowed to the keys observed today. */
  context?: Record<string, string>;
}

/**
 * A payload key as a heading: `gitStatus` → `Git status`, `user_email` →
 * `User email`. Derived rather than looked up, so a block the harness starts
 * sending tomorrow gets a readable heading instead of falling out of a table.
 */
function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  const [first, ...rest] = words;
  if (!first) return key;
  return [
    first.charAt(0).toUpperCase() + first.slice(1),
    ...rest.map((word) => word.toLowerCase()),
  ].join(" ");
}

/**
 * The ambient facts the harness handed the agent at launch — who the user is,
 * what the repo looked like — as one `<system-reminder>` of `# key` blocks.
 *
 * A card, not a line: the blocks are long (a git status runs to a dozen lines)
 * and the reader almost never wants them, so the collapsed row states only how
 * many blocks arrived and the body carries the text. Collapsed by default —
 * this is context the agent received, not something the reader is looking for.
 */
export function SessionContextView({ event }: AttachmentRendererProps) {
  const payload = event.attachment as SessionContextPayload;
  const entries = Object.entries(payload.context ?? {});
  if (entries.length === 0) {
    throw new Error("session_context attachment carries no `context`");
  }

  return (
    <CollapsibleCard
      icon={<Icon icon={layersIcon} className="size-3.5" />}
      label="Session context"
      note={`· ${entries.length} block${entries.length === 1 ? "" : "s"}`}
    >
      <Scroll className="max-h-64">
        <Stack gap="sm">
          {entries.map(([key, value]) => (
            <Stack key={key} gap="2xs">
              <Text as="h4" variant="caption" className="text-foreground">
                {humanizeKey(key)}
              </Text>
              <Text
                as="pre"
                variant="caption"
                className="whitespace-pre-wrap break-words font-mono text-muted-foreground"
              >
                {value}
              </Text>
            </Stack>
          ))}
        </Stack>
      </Scroll>
    </CollapsibleCard>
  );
}
