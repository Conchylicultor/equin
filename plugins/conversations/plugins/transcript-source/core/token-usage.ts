import type { TokenUsage } from "./protocol";

/**
 * One assistant message's `usage` record, read into the four numbers every
 * token reading is folded from — or `undefined` when the record is missing or
 * reports nothing at all.
 *
 * The one reading of the raw shape, shared by the transcript parser and the
 * sub-agent scan, so a sub-agent's tokens and its parent's are counted the same
 * way.
 */
export function tokenUsageOf(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const usage: TokenUsage = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
  };
  if (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheCreation === 0
  ) {
    return undefined;
  }
  return usage;
}
