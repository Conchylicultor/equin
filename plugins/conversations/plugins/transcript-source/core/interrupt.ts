/**
 * Single source of truth for interrupt-sentinel detection.
 *
 * Recognizes the two distinct artifacts the Claude CLI writes when a pending
 * tool call is cancelled (e.g. Escaping an AskUserQuestion menu):
 *  1. The tool_result content on the cancelled tool_use — the "tool use was
 *     rejected" message (`result.content`, with is_error). This is what marks an
 *     AskUserQuestion as awaiting an answer.
 *  2. A separate standalone stop message (`[Request interrupted by user…]` /
 *     `this query was stopped by the user`) emitted as its own event.
 */

const INTERRUPT_SENTINELS = [
  "[Request interrupted by user",
  // Tool-rejection result written when a pending tool_use is cancelled/denied.
  "The user doesn't want to proceed with this tool use",
] as const;

const CASE_INSENSITIVE_SENTINELS = [
  "this query was stopped by the user",
] as const;

export function isInterruptContent(text: string): boolean {
  const trimmed = text.trim();
  for (const sentinel of INTERRUPT_SENTINELS) {
    if (trimmed.startsWith(sentinel)) return true;
  }
  const lower = trimmed.toLowerCase();
  for (const sentinel of CASE_INSENSITIVE_SENTINELS) {
    if (lower.startsWith(sentinel)) return true;
  }
  return false;
}
