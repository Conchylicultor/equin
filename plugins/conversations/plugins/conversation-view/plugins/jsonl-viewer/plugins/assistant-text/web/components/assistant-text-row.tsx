import { useRef } from "react";
import { ActiveDataMarkdown } from "@plugins/active-data/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  useRowMarkdown,
  useStreamingRow,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { EventRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useSteadyReveal } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/steady-reveal/web";

type AssistantTextEvent = Extract<JsonlEvent, { kind: "assistant-text" }>;

export function AssistantTextRow({ event }: { event: JsonlEvent }) {
  const e = event as AssistantTextEvent;
  const { markdownMode } = useRowMarkdown();
  const streaming = useStreamingRow();
  if (streaming)
    return <StreamingTextBody text={e.text} messageId={e.messageId ?? null} />;
  return (
    <AssistantTextBody
      text={e.text}
      messageId={e.messageId ?? null}
      markdown={markdownMode}
      rowActions
    />
  );
}

/**
 * How the agent's words look: a finished message's row, and the text it is
 * still writing (`StreamingTextBody`) — one body, so the two cannot differ
 * when the finished row replaces the streaming one.
 */
export function AssistantTextBody({
  text,
  messageId,
  markdown,
  rowActions = false,
}: {
  text: string;
  /** The API message id, which identifies active-data blocks; null when unknown. */
  messageId: string | null;
  markdown: boolean;
  /** The row's action strip (a transcript row's; a message still being written has none). */
  rowActions?: boolean;
}) {
  const { convId } = conversationPane.useParams();
  // First in the text so the prose wraps around it rather than running under it.
  const actions = rowActions ? <EventRowActions float /> : null;

  return (
    <ContentScope>
      {/* flow-root contains the floated actions, so a one-line message never
          lets them hang into the next row. */}
      <div className="flow-root px-md py-sm">
        {markdown ? (
          <Text as="div" variant="body">
            {actions}
            <ActiveDataMarkdown
              text={text}
              conversationId={convId}
              messageId={messageId}
            />
          </Text>
        ) : (
          <Text
            as="div"
            variant="body"
            className="whitespace-pre-wrap break-words"
          >
            {actions}
            {text}
          </Text>
        )}
      </div>
    </ContentScope>
  );
}

/**
 * A text block the agent is still writing, revealed at a steady pace
 * (`useSteadyReveal`) rather than in the bursts it arrives in. Always markdown:
 * the finished row it gives way to opens in markdown.
 */
function StreamingTextBody({
  text,
  messageId,
}: {
  text: string;
  messageId: string | null;
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
