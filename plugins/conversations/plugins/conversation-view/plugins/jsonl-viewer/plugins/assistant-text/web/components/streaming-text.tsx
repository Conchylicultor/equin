import { useRef, type ReactNode } from "react";
import type { Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import { conversationPartialMessage } from "@plugins/conversations/core";
import { useTranscriptEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { FOLLOW_MOTION_ATTR } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { unlandedBlocks } from "../internal/unlanded-blocks";
import { useSteadyReveal } from "../internal/use-steady-reveal";
import { AssistantTextBody } from "./assistant-text-row";
import "./streaming-text.css";

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
        <EasedHeight>
          <div data-streaming-message={message.messageId}>
            {blocks.map((block) => (
              <StreamingBlock
                // Per message: a new message's reveal starts from nothing.
                key={`${message.messageId}:${block.index}`}
                text={block.text}
                messageId={message.messageId}
              />
            ))}
          </div>
        </EasedHeight>
      );
    }
  }
}

/** One text block of the message, revealed at a steady pace (`useSteadyReveal`). */
function StreamingBlock({
  text,
  messageId,
}: {
  text: string;
  messageId: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const shown = useSteadyReveal(text, body);
  return (
    <div ref={body}>
      <AssistantTextBody
        text={text.slice(0, shown)}
        messageId={messageId}
        markdown
      />
    </div>
  );
}

/**
 * Eases to its content's height on each line the reveal wraps onto — so the transcript glides rather than
 * stepping a line at a time. Stamped `FOLLOW_MOTION_ATTR`, so a transcript
 * following the bottom follows the easing frame by frame.
 */
function EasedHeight({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useResizeObserver(
    content,
    () => {
      const outer = frame.current;
      const inner = content.current;
      if (outer && inner) outer.style.height = `${inner.offsetHeight}px`;
    },
    // Undebounced: the easing starts on the frame the content grew.
    { debounce: false },
  );
  return (
    <div
      ref={frame}
      className="streaming-text-frame"
      {...{ [FOLLOW_MOTION_ATTR]: "" }}
    >
      <div ref={content}>{children}</div>
    </div>
  );
}
