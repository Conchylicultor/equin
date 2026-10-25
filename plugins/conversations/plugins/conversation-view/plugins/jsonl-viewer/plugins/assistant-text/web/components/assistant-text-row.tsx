import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  useRowMarkdown,
  useStreamingRow,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { EventRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { AgentProse } from "./agent-prose";

type AssistantTextEvent = Extract<JsonlEvent, { kind: "assistant-text" }>;

export function AssistantTextRow({ event }: { event: JsonlEvent }) {
  const e = event as AssistantTextEvent;
  const { markdownMode } = useRowMarkdown();
  const streaming = useStreamingRow();
  // A message still being written has no action strip, and always opens in
  // markdown: the finished row it gives way to opens in markdown.
  return (
    <AssistantTextBody
      text={e.text}
      messageId={e.messageId ?? null}
      markdown={streaming || markdownMode}
      streaming={streaming}
    />
  );
}

/**
 * How the agent's words look in the transcript: a finished message's row, and
 * the text it is still writing — one body (`AgentProse`), so the two cannot
 * differ when the finished row replaces the streaming one.
 */
export function AssistantTextBody({
  text,
  messageId,
  markdown,
  streaming,
}: {
  text: string;
  /** The API message id, which identifies active-data blocks; null when unknown. */
  messageId: string | null;
  markdown: boolean;
  /** A stand-in for a block still being written: revealed steadily, with no action strip. */
  streaming: boolean;
}) {
  const { convId } = conversationPane.useParams();
  // First in the text so the prose wraps around it rather than running under it.
  const actions = streaming ? null : <EventRowActions float />;

  return (
    <ContentScope>
      {/* flow-root contains the floated actions, so a one-line message never
          lets them hang into the next row. */}
      <div className="flow-root px-md py-sm">
        {markdown ? (
          <AgentProse
            text={text}
            conversationId={convId}
            messageId={messageId}
            streaming={streaming}
            leading={actions}
          />
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
