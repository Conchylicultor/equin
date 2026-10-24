import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { useActiveDataSegments } from "./segment-active-data";
import { ActiveDataIdentityProvider } from "./identity-context";

/**
 * An agent's message as markdown with its active-data blocks: each block
 * segment renders as its contributed component, the prose between them as
 * `Markdown` (whose enhancer draws the inline tags). One rendering for every
 * surface that shows what an agent wrote — the transcript row and an embedded
 * thread alike — so a block cannot look or behave differently between them.
 *
 * A block is bound to its identity (`conversationId`, `messageId`, its tag and
 * which occurrence of that tag it is), so a stateful one persists its state.
 * With no `messageId` (a transcript line that names none) the blocks still
 * render, without an identity.
 */
export function ActiveDataMarkdown({
  text,
  conversationId,
  messageId,
}: {
  text: string;
  conversationId: string;
  /** The API message id, which identifies active-data blocks; null when unknown. */
  messageId: string | null;
}) {
  const segments = useActiveDataSegments(text);
  const counts = new Map<string, number>();
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type !== "block") {
          return <Markdown key={i}>{seg.text}</Markdown>;
        }
        const idx = counts.get(seg.tag) ?? 0;
        counts.set(seg.tag, idx + 1);
        const block = <seg.component content={seg.content} attrs={seg.attrs} />;
        if (!messageId) return <span key={i}>{block}</span>;
        return (
          <ActiveDataIdentityProvider
            key={i}
            conversationId={conversationId}
            messageId={messageId}
            tag={seg.tag}
            occurrenceIndex={idx}
          >
            {block}
          </ActiveDataIdentityProvider>
        );
      })}
    </>
  );
}
