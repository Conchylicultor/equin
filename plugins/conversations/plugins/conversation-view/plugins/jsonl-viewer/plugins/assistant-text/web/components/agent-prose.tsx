import { useRef, type ReactNode } from "react";
import { ActiveDataMarkdown } from "@plugins/active-data/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useSteadyReveal } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/steady-reveal/web";

export interface AgentProseProps {
  /** The agent's words: the whole text, or — `streaming` — what has been written so far. */
  text: string;
  /** The conversation that wrote them — with `messageId`, the identity of their active-data blocks. */
  conversationId: string;
  /** The API message id that carries them; null when unknown. */
  messageId: string | null;
  /**
   * The agent is still writing the text (a stand-in for its block): it is
   * revealed at a steady pace, its newest words fading in, rather than in the
   * bursts it arrives in.
   */
  streaming: boolean;
  /** Drawn first inside the prose, so it wraps around it (a floated action strip). */
  leading?: ReactNode;
}

/**
 * The agent's words, as markdown with active-data — the one look of an
 * assistant reply wherever it is shown (a transcript row, an agent thread's
 * answer), still being written or finished — so the finished text replacing
 * the streaming one changes nothing but how much of it shows.
 */
export function AgentProse(props: AgentProseProps) {
  return props.streaming ? <StreamingProse {...props} /> : <Prose {...props} />;
}

function Prose({ text, conversationId, messageId, leading }: AgentProseProps) {
  return (
    <Text as="div" variant="body">
      {leading}
      <ActiveDataMarkdown
        text={text}
        conversationId={conversationId}
        messageId={messageId}
      />
    </Text>
  );
}

function StreamingProse(props: AgentProseProps) {
  const body = useRef<HTMLDivElement>(null);
  const shown = useSteadyReveal(props.text, body);
  return (
    <div ref={body}>
      <Prose {...props} text={props.text.slice(0, shown)} />
    </div>
  );
}
