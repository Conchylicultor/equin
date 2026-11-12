import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/** `exit_clean` has no input and answers `{ ok, deferred }`: the whole fact is
 *  that the agent closed the conversation, so the row is one line. */
/** `exit_clean` takes no input: the card reads none. */
export const ExitCleanInputSchema = z.unknown();

export function ExitCleanToolView({ event }: ToolViewProps<unknown>) {
  const failed = event.result?.isError === true;
  return (
    <ToolCallCard
      event={event}
      summary="Closing the conversation"
      note="· all smooth"
      defaultOpen={failed}
    >
      {failed && (
        <Text
          as="p"
          variant="caption"
          className="text-destructive whitespace-pre-wrap"
        >
          {event.result?.content}
        </Text>
      )}
    </ToolCallCard>
  );
}
