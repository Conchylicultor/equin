import {
  emptyUsageBuckets,
  foldUsageEntry,
  type UsageBuckets,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";

// The pure half of the cost at a reading position (`cost-at.ts`): which lines
// of a conversation's transcripts carry usage, and the ledger's own fold
// (`foldUsageEntry`) over the ones written in a stretch of time — so the
// stretch is counted exactly as the sync counts it into the ledger: one entry
// per message, at its largest output, tiered per entry, cache writes split by
// TTL, deduped across the files of a resumed chain.

/** A transcript line that carries usage, as the fold reads it, with its instant. */
export interface UsageLine {
  /** The line's timestamp, epoch ms. */
  t: number;
  /** The fields `foldUsageEntry` reads, and nothing else (the memo holds these). */
  entry: {
    timestamp: string;
    requestId?: string;
    message: { id?: string; model?: string; usage: unknown };
  };
}

/**
 * The usage line `text` is, or null: not JSON (a torn or foreign line is the
 * transcript reader's to report), no usage, or no timestamp — a line with no
 * instant cannot be placed before or after a reading position.
 */
export function usageLineOf(text: string): UsageLine | null {
  // Most lines carry no usage: skip them before paying for the parse.
  if (!text.includes('"usage"')) return null;
  let line: unknown;
  try {
    line = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  if (typeof line !== "object" || line === null) return null;
  const { timestamp, requestId, message } = line as Record<string, unknown>;
  if (typeof timestamp !== "string") return null;
  if (typeof message !== "object" || message === null) return null;
  const { id, model, usage } = message as Record<string, unknown>;
  if (typeof usage !== "object" || usage === null) return null;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return null;
  return {
    t,
    entry: {
      timestamp,
      ...(typeof requestId === "string" ? { requestId } : {}),
      message: {
        ...(typeof id === "string" ? { id } : {}),
        ...(typeof model === "string" ? { model } : {}),
        usage,
      },
    },
  };
}

/**
 * The ledger's fold of every usage line written in `[from, to]` (epoch ms),
 * over `files` in the order the sync reads them (the session chain, oldest
 * first, then the sub-agents) through ONE seen-set, so a resumed session's
 * copied history counts once.
 */
export function foldStretch(
  files: readonly (readonly UsageLine[])[],
  from: number,
  to: number,
): UsageBuckets {
  const fold = emptyUsageBuckets();
  for (const lines of files) {
    for (const line of lines) {
      if (line.t >= from && line.t <= to) foldUsageEntry(fold, line.entry);
    }
  }
  return fold;
}
