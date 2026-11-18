/**
 * What used a ledger row's tokens (`claude_usage_hours.source`): a plain text
 * key, never a foreign key — an account's usage outlives what used it.
 *
 * - `conv:<conversationId>` — an agent conversation, filed by the usage sync
 *   (conversations/usage) from its transcripts.
 * - `cli:<sourceName>` — a one-shot generation (`runClaudePrint` /
 *   `runClaudeReadOnly`), filed by the call recorder with the caller's
 *   `source.name` (`cli:task-title`, …).
 * - `session:<claudeSessionId>` — a Claude Code session equin did not launch
 *   (no equin conversation owns its transcript), filed by the transcript
 *   scanner from its `<sessionId>.jsonl`.
 */
export const SPEND_SOURCE_PREFIX = {
  conversation: "conv:",
  cli: "cli:",
  session: "session:",
} as const;

export type SpendSource =
  | `${typeof SPEND_SOURCE_PREFIX.conversation}${string}`
  | `${typeof SPEND_SOURCE_PREFIX.cli}${string}`
  | `${typeof SPEND_SOURCE_PREFIX.session}${string}`;

/** The source a conversation's spend is filed under. */
export function conversationSpendSource(conversationId: string): SpendSource {
  return `${SPEND_SOURCE_PREFIX.conversation}${conversationId}`;
}

/** The source a one-shot call's spend is filed under (its caller's name). */
export function cliSpendSource(sourceName: string): SpendSource {
  return `${SPEND_SOURCE_PREFIX.cli}${sourceName}`;
}

/** The source a Claude Code session equin did not launch is filed under. */
export function sessionSpendSource(claudeSessionId: string): SpendSource {
  return `${SPEND_SOURCE_PREFIX.session}${claudeSessionId}`;
}

/**
 * The account of usage counted before accounts were recorded (or by a pass
 * that cannot know which account spent it) — `claude_usage_hours.account_id`.
 */
export const UNKNOWN_ACCOUNT = "unknown";

/**
 * The account id of usage a transcript names the claude.ai login of (its
 * `session-owner` record) when that login is none of equin's accounts — not
 * the computer's login now (that is the system account). Its own account,
 * never a guess at one of equin's.
 */
export function claudeLoginAccountId(accountUuid: string): string {
  return `claude-login:${accountUuid}`;
}

/** The UTC hour `instant` falls in — the ledger's time key. */
export function spendHourOf(instant: Date): Date {
  const hour = new Date(instant.getTime());
  hour.setUTCMinutes(0, 0, 0);
  return hour;
}

/**
 * What wrote a token-ledger row (`claude_usage_hours.origin`): `counted` — a
 * writer filing what it read (the transcript scanners, the call recorder);
 * `imported` — the one-shot history import of what no scanner can read again
 * (the permanent archive of deleted transcripts, and conversation counts from
 * before the ledger). A scanner takes back only its own `counted` rows.
 */
export type UsageOrigin = "counted" | "imported";
