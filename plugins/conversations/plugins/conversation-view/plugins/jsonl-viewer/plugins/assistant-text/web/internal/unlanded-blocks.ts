import type { PartialBlock, PartialMessage } from "@plugins/conversations/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * The blocks of the streaming message the transcript does not show yet.
 *
 * The CLI writes a message's text block to the transcript once it is finished,
 * and the parser merges a message's text blocks into one `assistant-text`
 * event per message id. A block has landed once that event holds its text
 * (the event's, being finished, is the fuller one) — so the streaming block
 * goes in the same render that draws the finished row: no gap, no double.
 * A block with nothing visible yet is not drawn.
 */
export function unlandedBlocks(
  message: PartialMessage,
  events: readonly JsonlEvent[],
): PartialBlock[] {
  let landed = "";
  for (const e of events)
    if (e.kind === "assistant-text" && e.messageId === message.messageId)
      landed += e.text;
  return message.blocks
    .filter((b) => {
      const text = b.text.trim();
      return text !== "" && !landed.includes(text);
    })
    .sort((a, b) => a.index - b.index);
}
