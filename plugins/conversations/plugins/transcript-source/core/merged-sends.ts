/**
 * The other sends the CLI merged into this user line. Several prompts queued
 * while the agent worked are dequeued together into ONE user line: it carries
 * the first send's uuid as its own `uuid`, and the rest under
 * `mergedSendUuids` — those sends have no line of their own (seen with CLI
 * 2.1.310: two `event` turns sent 2 ms apart, one line). The turn ledger's
 * confirmation names each send by its own uuid, so a reader looking for a
 * turn's line must match these too.
 */
export function mergedSendUuids(line: Record<string, unknown>): string[] {
  const merged = line.mergedSendUuids;
  if (!Array.isArray(merged)) return [];
  return merged.filter((u): u is string => typeof u === "string");
}
