import {
  tokenUsageOf,
  type TokenUsage,
} from "@plugins/conversations/plugins/transcript-source/core";

/**
 * A running total of a sub-agent's token usage, folded line by line.
 *
 * The harness writes one line per content block of an assistant message, and
 * every one of them repeats the message's `usage` — so a message counts once,
 * by its id, on the FIRST line that carries it. That is the transcript
 * parser's rule for the main conversation too, which is what makes a
 * sub-agent's tokens and its parent's add up to one comparable total.
 */
export interface UsageFold {
  totals: TokenUsage;
  /** Ids of the messages already counted. */
  counted: Set<string>;
}

export function emptyUsageFold(): UsageFold {
  return {
    totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    counted: new Set(),
  };
}

/** Add one parsed transcript line to `fold`, in place. */
export function foldUsageLine(
  fold: UsageFold,
  line: Record<string, unknown>,
): void {
  if (line.type !== "assistant") return;
  const message = line.message;
  if (typeof message !== "object" || message === null) return;
  const { role, id, usage: raw } = message as Record<string, unknown>;
  if (role !== "assistant" || typeof id !== "string" || fold.counted.has(id)) {
    return;
  }
  const usage = tokenUsageOf(raw);
  if (!usage) return;
  fold.counted.add(id);
  fold.totals.input += usage.input;
  fold.totals.output += usage.output;
  fold.totals.cacheRead += usage.cacheRead;
  fold.totals.cacheCreation += usage.cacheCreation;
}
