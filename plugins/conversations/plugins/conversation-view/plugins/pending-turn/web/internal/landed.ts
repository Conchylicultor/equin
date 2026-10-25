import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { LedgerTurn } from "@plugins/conversations/plugins/turn-ledger/core";

// Whether the transcript a tab renders already shows a ledger turn — the
// moment its echo has nothing left to stand in for. The echo and the message
// reach the tab on two channels (the ledger's change feed, the transcript
// watcher), so neither alone retires it:
//
//   - the LEDGER says which turn: only the agent's own confirmation
//     (`accepted` / `merged`, stamped `submittedAt`) names this exact turn as
//     taken. A turn still `typing` / `typed` / `held` is not known to be
//     anywhere but the echo — nothing guesses it landed;
//   - the TRANSCRIPT says when it is on screen: the agent writes the prompt
//     when it takes it, so once the transcript holds an event at or after
//     `submittedAt` it holds the prompt too. Retiring on the confirmation
//     alone left the turn on screen nowhere for as long as the transcript
//     lagged.
//
// Only the newest event is read: the tab's transcript is a tail window
// (closed under "after"), so the answer does not depend on how much of the
// past is loaded. The error this can make is a turn shown twice for a moment
// (the prompt is written but nothing after it yet) — never a turn shown
// nowhere. The message itself, found by the uuid the agent confirmed it
// under, settles it at once: a prompt folded into a running turn is written
// with the time it was queued, before the confirmation's.

/**
 * Whether a turn is a slash command: the CLI runs it rather than writing it as
 * a prompt, so the transcript holds no prompt row for it — the agent's
 * confirmation (`accepted`) is the last word on it.
 */
export function isSlashCommand(row: Pick<LedgerTurn, "text">): boolean {
  return row.text.trimStart().startsWith("/");
}

/** When the newest event of `events` (oldest first) was written, epoch ms. */
export function transcriptReachedAt(
  events: readonly JsonlEvent[],
): number | null {
  const newest = events.at(-1);
  return newest ? Date.parse(newest.at) : null;
}

/**
 * Whether the transcript `events` (oldest first) shows `row`: the agent
 * confirmed taking it, and the transcript holds the message it confirmed (by
 * its uuid) or reaches the moment it did.
 */
export function transcriptShows(
  row: Pick<LedgerTurn, "state" | "submittedAt" | "promptUuid">,
  events: readonly JsonlEvent[],
): boolean {
  if (row.state !== "accepted" && row.state !== "merged") return false;
  if (
    row.promptUuid !== null &&
    events.some((e) => e.kind === "user-text" && e.uuid === row.promptUuid)
  ) {
    return true;
  }
  const reachedAt = transcriptReachedAt(events);
  if (row.submittedAt === null || reachedAt === null) return false;
  return reachedAt >= row.submittedAt.getTime();
}
