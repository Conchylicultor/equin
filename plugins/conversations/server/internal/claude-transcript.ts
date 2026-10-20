import {
  activeLineUuids,
  unwrapPastedContent,
} from "@plugins/conversations/plugins/transcript-watcher/core";
import { readChainLines } from "@plugins/conversations/plugins/transcript-watcher/server";

export type TurnRole = "user" | "assistant";

export interface Turn {
  /** ISO timestamp of the first JSONL event that contributed to this turn. */
  at: string;
  role: TurnRole;
  /** Concatenated text content. Empty string if the turn had no text blocks. */
  text: string;
  /** Present on assistant turns only; propagated from the last event in the turn. */
  stopReason?: string;
  /** Assistant-only message id; equal-id events are merged into one turn. */
  messageId?: string;
}

/** Transcript lines → file content. One home so every writer ends the file the same way. */
export function serializeTranscript(lines: readonly string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function readTurns(path: string, sinceIso?: string): Promise<Turn[]> {
  return readTurnsFromChain([path], sinceIso);
}

/**
 * Read the turns of a conversation spread over a chain of session files.
 *
 * `readChainLines` concatenates the chain in order and drops duplicate uuids
 * (a forked session copies its ancestor's lines verbatim), then `activeLineUuids`
 * drops the branches a rewind (or a midpoint fork) left behind. Both passes are
 * required over a chain: the dedup keeps a fork's copied lines from rendering
 * twice, the branch filter keeps the ancestor's abandoned remainder out.
 * `sinceIso` stays a post-parse filter — it must not narrow the forest the
 * branch filter reasons over.
 */
export async function readTurnsFromChain(
  paths: string[],
  sinceIso?: string,
): Promise<Turn[]> {
  const lines = await readChainLines(paths);
  const active = activeLineUuids(lines);

  const turns: Turn[] = [];
  const assistantByMsgId = new Map<string, Turn>();

  for (const obj of lines) {
    const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
    if (uuid && !active.has(uuid)) continue; // abandoned rewind branch
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
    if (!ts) continue;
    if (sinceIso && ts < sinceIso) continue;

    const msg = obj.message as
      | {
          role?: string;
          content?: unknown;
          id?: string;
          stop_reason?: string;
        }
      | undefined;

    if (obj.type === "user" && msg?.role === "user") {
      // User turns have string content; tool_result arrays are skipped.
      // Unwrapped for the same reason userPromptText unwraps: a turn the
      // person pasted says what a turn they typed says, and these turns feed
      // the summary, title and category the reader sees.
      if (typeof msg.content === "string" && msg.content.length > 0) {
        turns.push({
          at: ts,
          role: "user",
          text: unwrapPastedContent(msg.content),
        });
      }
      continue;
    }

    if (obj.type === "assistant" && msg?.role === "assistant") {
      const texts: string[] = [];
      if (Array.isArray(msg.content)) {
        for (const c of msg.content as Array<{
          type?: string;
          text?: string;
        }>) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
          if (c?.type === "text" && typeof c.text === "string") {
            texts.push(c.text);
          }
        }
      }
      const added = texts.join("");
      const msgId = msg.id;
      if (msgId) {
        const existing = assistantByMsgId.get(msgId);
        if (existing) {
          existing.text += added;
          if (msg.stop_reason) existing.stopReason = msg.stop_reason;
        } else {
          const turn: Turn = {
            at: ts,
            role: "assistant",
            text: added,
            stopReason: msg.stop_reason,
            messageId: msgId,
          };
          assistantByMsgId.set(msgId, turn);
          turns.push(turn);
        }
      } else if (added) {
        turns.push({
          at: ts,
          role: "assistant",
          text: added,
          stopReason: msg.stop_reason,
        });
      }
    }
  }
  return turns;
}
