/**
 * What spent a ledger row's cost (`claude_spend_hours.source`): a plain text
 * key, never a foreign key — an account's spend outlives what spent it.
 *
 * - `conv:<conversationId>` — an agent conversation, filed by the usage sync
 *   (conversations/usage) from its transcripts.
 * - `cli:<sourceName>` — a one-shot generation (`runClaudePrint` /
 *   `runClaudeReadOnly`), filed by the call recorder with the caller's
 *   `source.name` (`cli:task-title`, …).
 * - `unattributed` — spend counted before the ledger kept a source (the
 *   per-day history migrated from `conversation_usage_account_days`, at
 *   00:00 UTC of its day). Nothing writes it any more.
 */
export const SPEND_SOURCE_PREFIX = {
  conversation: "conv:",
  cli: "cli:",
} as const;

export const UNATTRIBUTED_SPEND_SOURCE = "unattributed";

export type SpendSource =
  | `${typeof SPEND_SOURCE_PREFIX.conversation}${string}`
  | `${typeof SPEND_SOURCE_PREFIX.cli}${string}`
  | typeof UNATTRIBUTED_SPEND_SOURCE;

/** The source a conversation's spend is filed under. */
export function conversationSpendSource(conversationId: string): SpendSource {
  return `${SPEND_SOURCE_PREFIX.conversation}${conversationId}`;
}

/** The source a one-shot call's spend is filed under (its caller's name). */
export function cliSpendSource(sourceName: string): SpendSource {
  return `${SPEND_SOURCE_PREFIX.cli}${sourceName}`;
}

/** The UTC hour `instant` falls in — the ledger's time key. */
export function spendHourOf(instant: Date): Date {
  const hour = new Date(instant.getTime());
  hour.setUTCMinutes(0, 0, 0);
  return hour;
}
