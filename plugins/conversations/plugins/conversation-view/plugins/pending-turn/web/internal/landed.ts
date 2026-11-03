import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  transcriptUuidOfTurn,
  type LedgerTurn,
  type TurnId,
} from "@plugins/conversations/plugins/turn-ledger/core";

// Whether the transcript a tab renders already shows a ledger turn — the
// moment its echo has nothing left to stand in for. The echo and the message
// reach the tab on two channels (the ledger's change feed, the transcript
// watcher):
//
//   - the LEDGER says which line: the agent's confirmation (`accepted`)
//     records the uuid of the transcript line the turn became
//     (`promptUuid`). A turn still `typing` / `typed` / `held` is not known to
//     be anywhere but the echo — nothing guesses it landed;
//   - the TRANSCRIPT says when that line is on screen: the tab's window holds
//     an event carrying the uuid, or the window begins after the agent took
//     the turn, so its line is above what is loaded.
//
// Since the agent queues a turn under its id's own uuid
// (`transcriptUuidOfTurn`), the line is also findable from the id alone —
// whichever channel lands first retires the echo, so a ledger update lagging
// the transcript (a loaded server) no longer shows the message twice.
//
// The line an agent writes for a turn (measured over 1,141 sdk turns,
// 2026-10-25): a user line with the turn's uuid — a slash command too; or, for
// `/compact`, whose line Claude Code writes after the compaction it ran, the
// `compaction` event the parser folds that line into (`requestUuid`); or, for a
// turn sent
// while the agent was busy and folded into the running turn at a tool
// boundary, a `queued_command` attachment whose `source_uuid` is the turn's
// uuid, which the transcript parser turns into the user's own message under
// that uuid. Either way: a `user-text` event carrying `promptUuid` — or, for
// an `event` turn (typed in the ledger's envelope), an `event-turn` event.
// Sends queued together can be dequeued as ONE line: it carries the first
// send's uuid, the rest under `mergedSendUuids` — so a turn's line is the
// event carrying its uuid in either place.
//
// The agent confirms a turn when its CLI STARTS it (not when it is queued),
// so `submittedAt` is never earlier than the turn's place in the transcript:
// a window beginning after it has the line above it.

/**
 * Whether `events` (the loaded transcript window, oldest first) shows turn
 * `id`'s own line — the one its id names (`transcriptUuidOfTurn`), before any
 * confirmation reached the tab. True only from the agents that queue a turn
 * under that uuid; for an older one, {@link transcriptShows} waits for the
 * ledger to say which line.
 */
export function transcriptHoldsTurn(
  id: TurnId,
  events: readonly JsonlEvent[],
): boolean {
  return holdsLine(events, transcriptUuidOfTurn(id));
}

/**
 * Whether `events` (the loaded transcript window, oldest first) shows `row`:
 * its own line is in the window ({@link transcriptHoldsTurn}) — or the agent
 * confirmed it, and the line it was confirmed as is in the window, or above
 * it, the window beginning after the agent took it.
 */
export function transcriptShows(
  row: Pick<LedgerTurn, "id" | "state" | "submittedAt" | "promptUuid">,
  events: readonly JsonlEvent[],
): boolean {
  if (transcriptHoldsTurn(row.id, events)) return true;
  if (row.state !== "accepted" || row.submittedAt === null) return false;
  const oldest = events[0];
  if (oldest === undefined) return false;
  const { promptUuid } = row;
  if (promptUuid === null)
    return legacyTranscriptShows(row.submittedAt, events);
  if (Date.parse(oldest.at) > row.submittedAt.getTime()) return true;
  return holdsLine(events, promptUuid);
}

/** Whether a turn's transcript line — under `uuid`, or merged into another's — is in `events`. */
function holdsLine(events: readonly JsonlEvent[], uuid: string): boolean {
  return events.some((event) =>
    event.kind === "compaction"
      ? event.requestUuid === uuid
      : (event.kind === "user-text" || event.kind === "event-turn") &&
        (event.uuid === uuid || event.mergedSendUuids?.includes(uuid) === true),
  );
}

/**
 * TEMPORARY — a row accepted before the ledger recorded `promptUuid`: the old
 * guess, the transcript's newest event at or after the confirmation. Such rows
 * are settled, and retention sweeps settled rows a week after their last
 * change, so none is left — and this can go — 7 days after the `prompt_uuid`
 * column reached main (every confirmation since stamps it, the temporary
 * id-less one included).
 */
function legacyTranscriptShows(
  submittedAt: Date,
  events: readonly JsonlEvent[],
): boolean {
  const newest = events.at(-1);
  return newest !== undefined && Date.parse(newest.at) >= submittedAt.getTime();
}
