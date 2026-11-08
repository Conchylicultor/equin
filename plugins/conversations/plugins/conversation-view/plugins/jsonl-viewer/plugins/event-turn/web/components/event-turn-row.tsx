import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const eventIcon = symbol("notifications");

type EventTurnEvent = Extract<JsonlEvent, { kind: "event-turn" }>;

/** The body's first non-blank line — what the folded card says. */
function headline(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/**
 * An event the app delivered to a watching agent: something happened in the
 * subtree it watches (a report, a flag, the subtree going quiet). The app's
 * voice, not the user's — a neutral dashed card like the harness's own turns,
 * folded to its first line; the whole body (every event line, then the
 * subtree digest) opens below. The one look of an event turn: the transcript
 * row, and any other surface drawing one (the agent thread) or its echo.
 */
export function EventTurnCard({ text }: { text: string }) {
  return (
    <CollapsibleCard
      className="border-dashed"
      icon={<Icon icon={eventIcon} className="size-3.5" />}
      label="Event"
      summary={headline(text)}
    >
      <Text
        as="div"
        variant="caption"
        className="break-words text-muted-foreground"
      >
        <Markdown>{text}</Markdown>
      </Text>
    </CollapsibleCard>
  );
}

/** The transcript's `event-turn` row. */
export function EventTurnRow({ event }: { event: JsonlEvent }) {
  return <EventTurnCard text={(event as EventTurnEvent).text} />;
}
