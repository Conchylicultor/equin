import {
  ActiveDataIdentityProvider,
  useActiveDataSegments,
} from "@plugins/active-data/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useRowMarkdown } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { EventRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

type AssistantTextEvent = Extract<JsonlEvent, { kind: "assistant-text" }>;

export function AssistantTextRow({ event }: { event: JsonlEvent }) {
  const e = event as AssistantTextEvent;
  const { markdownMode } = useRowMarkdown();
  const { convId } = conversationPane.useParams();
  const segments = useActiveDataSegments(e.text);
  // First in the text so the prose wraps around it rather than running under it.
  const actions = <EventRowActions float />;

  return (
    <ContentScope>
      {/* flow-root contains the floated actions, so a one-line message never
          lets them hang into the next row. */}
      <div className="flow-root px-md py-sm">
        {markdownMode ? (
          <Text as="div" variant="body">
            {actions}
            {(() => {
              const counts = new Map<string, number>();
              return segments.map((seg, i) => {
                if (seg.type !== "block") {
                  return <Markdown key={i}>{seg.text}</Markdown>;
                }
                const idx = counts.get(seg.tag) ?? 0;
                counts.set(seg.tag, idx + 1);
                const block = (
                  <seg.component content={seg.content} attrs={seg.attrs} />
                );
                if (!e.messageId) return <span key={i}>{block}</span>;
                return (
                  <ActiveDataIdentityProvider
                    key={i}
                    conversationId={convId}
                    messageId={e.messageId}
                    tag={seg.tag}
                    occurrenceIndex={idx}
                  >
                    {block}
                  </ActiveDataIdentityProvider>
                );
              });
            })()}
          </Text>
        ) : (
          <Text
            as="div"
            variant="body"
            className="whitespace-pre-wrap break-words"
          >
            {actions}
            {e.text}
          </Text>
        )}
      </div>
    </ContentScope>
  );
}
