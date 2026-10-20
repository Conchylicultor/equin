import type { Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import { conversationPartialMessage } from "@plugins/conversations/core";
import { useTranscriptEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { unlandedBlocks } from "../internal/unlanded-blocks";
import { AssistantTextBody } from "./assistant-text-row";

/**
 * The message the agent is writing, drawn at the end of the transcript as the
 * model streams it, until the transcript's finished row holds its text.
 */
export function StreamingText({
  conversation,
}: {
  conversation: Conversation;
}) {
  const partial = useLive(conversationPartialMessage, { id: conversation.id });
  const events = useTranscriptEvents();
  switch (partial.status) {
    case "unavailable":
      // No computer behind this page (the demo): no agent is writing.
      return null;
    case "loading":
      // Not known yet: nothing is drawn — exactly what the transcript shows
      // until a finished row lands, so nothing reverses itself.
      return null;
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          subject="the message being written"
          error={partial.error}
          refetch={partial.refetch}
        />
      );
    case "ready": {
      const message = partial.data;
      if (!message) return null;
      const blocks = unlandedBlocks(message, events);
      if (blocks.length === 0) return null;
      return (
        // The attribute marks the block for e2e/first-token.ts.
        <div data-streaming-message={message.messageId}>
          {blocks.map((block) => (
            <AssistantTextBody
              key={block.index}
              text={block.text}
              messageId={message.messageId}
              markdown
            />
          ))}
        </div>
      );
    }
  }
}
