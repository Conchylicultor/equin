import { hookRecordOf } from "./hook-record";

/** A finished agent turn: its last message ended the turn and its Stop hooks let the agent stop. */
export interface TurnEnd {
  messageId: string;
  /** The message's text blocks, joined as the event builder joins them. */
  text: string;
}

/**
 * Finds where agent turns end, one raw transcript line at a time, holding only
 * the turn in progress — for a caller that follows a transcript's APPENDS (the
 * turn-emitter) and so never needs the whole chain's events.
 *
 * It answers what `buildJsonlEvents` answers for an `assistant-text` event with
 * `stopReason: "end_turn"` and `stopHooks: "allowed"`: Claude Code writes the
 * turn's last message (end_turn), runs its Stop hooks — a block is a Stop
 * `hook_blocking_error` attachment — then writes one `stop_hook_summary` line.
 * The turn is over at that summary, unless a hook blocked it. `turn-end.test.ts`
 * holds the two to the same answer over the same transcripts.
 *
 * `feed` returns the turn a line ends, else null.
 */
export function createTurnEndTracker(): {
  feed: (line: Record<string, unknown>) => TurnEnd | null;
} {
  // The assistant message being read (one message spans a line per block).
  let message: { id: string; text: string | null } | null = null;
  // The end_turn message whose Stop hooks have not answered yet.
  let pending: { id: string; text: string } | null = null;
  let blocked = false;
  // Tool-result lines the CLI filled in on resume after the session ended
  // mid-call: the synthetic reply it appends to one is no model's turn. Only
  // the latest matters — the filler directly follows its result line.
  let sessionEndedResult: string | null = null;

  return {
    feed(line) {
      const ts = line.timestamp;
      if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) return null;
      const type = line.type;
      const msg = line.message as
        | {
            id?: unknown;
            role?: unknown;
            content?: unknown;
            stop_reason?: unknown;
            model?: unknown;
          }
        | undefined;

      if (type === "user") {
        if (
          line.toolDenialKind === "interrupted" &&
          typeof line.uuid === "string"
        )
          sessionEndedResult = line.uuid;
        return null;
      }

      if (type === "assistant" && msg?.role === "assistant") {
        if (!Array.isArray(msg.content)) return null;
        if (
          msg.model === "<synthetic>" &&
          typeof line.parentUuid === "string" &&
          line.parentUuid === sessionEndedResult
        )
          return null;
        if (line.isApiErrorMessage === true) return null;
        if (typeof msg.id !== "string") return null;
        if (message?.id !== msg.id) message = { id: msg.id, text: null };
        for (const block of msg.content as ({
          type?: unknown;
          text?: unknown;
        } | null)[]) {
          if (block?.type === "text" && typeof block.text === "string")
            message.text = (message.text ?? "") + block.text;
        }
        if (msg.stop_reason === "end_turn" && message.text !== null) {
          pending = { id: message.id, text: message.text };
          blocked = false;
        }
        return null;
      }

      if (type === "attachment") {
        const att = line.attachment;
        if (!att || typeof att !== "object") return null;
        const subtype = (att as { type?: unknown }).type;
        if (subtype !== "hook_blocking_error") return null;
        const hook = hookRecordOf(subtype, att as Record<string, unknown>, ts);
        if (hook.kind === "hook" && hook.record.event === "Stop")
          blocked = true;
        return null;
      }

      if (type === "system" && line.subtype === "stop_hook_summary") {
        const ended = pending && !blocked ? pending : null;
        pending = null;
        blocked = false;
        return ended ? { messageId: ended.id, text: ended.text } : null;
      }
      return null;
    },
  };
}
