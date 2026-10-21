import type {
  ContextCategory,
  ContextUsage,
} from "@plugins/conversations/core";

/**
 * What "full" means for the ring: where the harness compacts on its own when
 * it says so, else the window itself.
 */
export function contextLimit(usage: ContextUsage): number {
  return usage.isAutoCompactEnabled && usage.autoCompactThreshold
    ? usage.autoCompactThreshold
    : usage.rawMaxTokens;
}

/**
 * Tokens left before the harness compacts on its own, or null when it does not
 * compact automatically or does not say where.
 */
export function tokensToAutoCompact(usage: ContextUsage): number | null {
  if (!usage.isAutoCompactEnabled || !usage.autoCompactThreshold) return null;
  return Math.max(0, usage.autoCompactThreshold - usage.totalTokens);
}

// The harness's own row name for the conversation itself — the one row a
// compaction shrinks. Its name is the only thing that sets it apart from the
// other `used` rows (the setup the agent starts with); a renamed row simply
// lands under Setup.
const MESSAGES_ROW = "Messages";

export interface ContextRows {
  messages: ContextCategory | null;
  setup: ContextCategory[];
  free: number;
  reserve: number;
}

/** The breakdown split the way the card reads it. Deferred rows are dropped: they are not in the window. */
export function contextRows(usage: ContextUsage): ContextRows {
  const used = usage.categories.filter(
    (c) => c.kind === "used" && c.tokens > 0,
  );
  const sum = (kind: ContextCategory["kind"]) =>
    usage.categories
      .filter((c) => c.kind === kind)
      .reduce((total, c) => total + c.tokens, 0);
  return {
    messages: used.find((c) => c.name === MESSAGES_ROW) ?? null,
    // Largest first, so the bar and the rows read in the same order.
    setup: used
      .filter((c) => c.name !== MESSAGES_ROW)
      .sort((a, b) => b.tokens - a.tokens),
    free: sum("free"),
    reserve: sum("buffer"),
  };
}
