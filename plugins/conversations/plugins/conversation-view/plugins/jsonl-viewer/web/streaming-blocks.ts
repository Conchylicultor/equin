import type { PartialBlock, PartialMessage } from "@plugins/conversations/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { parsePartialJson } from "@plugins/packages/plugins/partial-json/core";

/** A block of the streaming message, as the event its transcript row will be. */
export interface StandIn {
  /** `<messageId>:<block index>` — stable while the block grows. */
  key: string;
  event: JsonlEvent;
}

/**
 * The streaming message's blocks the transcript does not hold yet, each as a
 * stand-in for the event its row will draw, in block order.
 *
 * The CLI writes each block of a message to the transcript once it is
 * finished, in block order. A block has landed once the transcript holds it —
 * text: the message's merged `assistant-text` contains it (the event's, being
 * finished, is the fuller one); thinking: the message has as many thinking
 * events as this block's place among its thinking blocks; a tool call: its
 * `toolUseId` is in the transcript — or once any LATER block of the message
 * has, so a stand-in never sits below a row that follows it. A stand-in goes
 * in the same render that draws the finished row: no gap, no double.
 *
 * A text block with nothing visible yet is not drawn. `at` stamps every
 * stand-in (the time the page first saw the message).
 */
export function standInsOf(
  message: PartialMessage,
  events: readonly JsonlEvent[],
  at: string,
): StandIn[] {
  const { messageId } = message;
  let landedText = "";
  let landedThinking = 0;
  const landedCalls = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool-call") landedCalls.add(e.toolUseId);
    else if (e.kind === "assistant-text" && e.messageId === messageId)
      landedText += e.text;
    else if (e.kind === "assistant-thinking" && e.messageId === messageId)
      landedThinking++;
  }

  const blocks = [...message.blocks].sort((a, b) => a.index - b.index);
  let thinkingSeen = 0;
  const own = blocks.map((block): boolean => {
    switch (block.kind) {
      case "text": {
        const text = block.text.trim();
        return text !== "" && landedText.includes(text);
      }
      case "thinking":
        return landedThinking >= ++thinkingSeen;
      case "tool_use":
        return landedCalls.has(block.toolUseId);
    }
  });

  const out: StandIn[] = [];
  let laterLanded = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    laterLanded ||= own[i]!;
    if (laterLanded) continue;
    if (block.kind === "text" && block.text.trim() === "") continue;
    out.push({
      key: `${messageId}:${block.index}`,
      event: eventOf(block, messageId, at),
    });
  }
  return out.reverse();
}

/**
 * Each block's stand-in, by the block object: the partial message is patched
 * (only what was written since arrives) and structurally shared, so a block
 * that did not grow is the same object push after push — and keeps the same
 * event, which its row then skips re-rendering, and its tool input is not
 * parsed again.
 */
const standInEvents = new WeakMap<PartialBlock, Map<string, JsonlEvent>>();

function eventOf(
  block: PartialBlock,
  messageId: string,
  at: string,
): JsonlEvent {
  let byStamp = standInEvents.get(block);
  if (byStamp === undefined) standInEvents.set(block, (byStamp = new Map()));
  const stamp = `${messageId}\0${at}`;
  let event = byStamp.get(stamp);
  if (event === undefined)
    byStamp.set(stamp, (event = buildEvent(block, messageId, at)));
  return event;
}

function buildEvent(
  block: PartialBlock,
  messageId: string,
  at: string,
): JsonlEvent {
  switch (block.kind) {
    case "text":
      return { kind: "assistant-text", at, messageId, text: block.text };
    case "thinking":
      return {
        kind: "assistant-thinking",
        at,
        messageId,
        thinking: block.text,
      };
    case "tool_use":
      return {
        kind: "tool-call",
        at,
        messageId,
        toolUseId: block.toolUseId,
        name: block.name,
        input: parsePartialJson(block.inputJson),
      };
  }
}
