import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type {
  LedgerTurn,
  TurnState,
} from "@plugins/conversations/plugins/turn-ledger/core";

// Which of a conversation's ledger turns the transcript already shows — the
// moment an echo has nothing left to stand in for. The echo and the message
// reach the tab on two channels (the ledger's change feed, the transcript
// watcher); retiring the echo on the ledger's word left a gap whenever the
// transcript was slower. Retiring it on the transcript the tab itself renders
// leaves none.
//
// There is no id shared by a ledger row and its transcript line in every case:
// a turn sent to a busy agent is a `queue-operation` enqueue (no uuid), and the
// hook's prompt_id is the RUNNING turn's (research/2026-10-15, E3). So the join
// is causal and ordinal:
//
//   - a turn's transcript entry is written after the server recorded the turn
//     (`createdAt` — the same host's clock as the CLI's timestamps);
//   - sends are serialized per conversation, so the k-th turn on its way into
//     the CLI, oldest first, is the k-th prompt landing at or after the oldest
//     one's `createdAt`.
//
// Where the transcript is ambiguous (a prompt typed in the terminal meanwhile,
// a queued prompt whose user line reads differently from its enqueue) the
// error is an echo retired one landing early — never one held forever.

/**
 * The states of a turn the CLI was handed and may have written down. `held`
 * was not typed yet; `failed` / `unverified` draw their own card; `returned` /
 * `withdrawn` are no longer the agent's. A Record, so a new state is decided.
 */
const ON_ITS_WAY: Record<TurnState, boolean> = {
  held: false,
  typing: true,
  typed: true,
  accepted: true,
  merged: true,
  returned: false,
  failed: false,
  unverified: false,
  withdrawn: false,
};

/**
 * Whether a turn is a slash command: the CLI runs it rather than writing it as
 * a prompt, so the transcript holds no prompt row for it to land as — the
 * agent's confirmation (`accepted`) is the last word on it.
 */
export function isSlashCommand(row: Pick<LedgerTurn, "text">): boolean {
  return row.text.trimStart().startsWith("/");
}

/** Whether a ledger turn's text should land as a prompt in the transcript. */
function landsAsPrompt(row: LedgerTurn): boolean {
  // An answer resolves a question: it lands as the tool's result.
  return row.kind !== "answer" && !isSlashCommand(row) && ON_ITS_WAY[row.state];
}

/**
 * When each prompt the CLI took landed in the transcript (epoch ms), in file
 * order: a typed prompt's user row, or a busy agent's enqueue. A queued prompt
 * the CLI later dequeues comes back as a user row of its own — that row is the
 * same prompt, matched by its text, and is not counted twice.
 */
export function promptLandings(events: readonly JsonlEvent[]): number[] {
  const out: number[] = [];
  const queued: string[] = [];
  const dequeued: string[] = [];
  for (const event of events) {
    if (event.kind === "queue-operation") {
      const content = event.content?.trim();
      if (event.operation === "enqueue" && content) {
        out.push(Date.parse(event.at));
        queued.push(content);
      } else if (event.operation === "dequeue") {
        const head = queued.shift();
        if (head !== undefined) dequeued.push(head);
      } else if (event.operation === "remove" && content) {
        const at = queued.indexOf(content);
        if (at >= 0) queued.splice(at, 1);
      }
      continue;
    }
    if (event.kind === "user-text" && event.uuid) {
      const at = dequeued.indexOf(event.text.trim());
      if (at >= 0) dequeued.splice(at, 1);
      else out.push(Date.parse(event.at));
    }
  }
  return out;
}

/**
 * The ids of the ledger turns (any order) the transcript `events` already
 * show. Only turns on their way into the CLI are matched; the rest are never in
 * the set.
 */
export function landedTurnIds(
  rows: readonly LedgerTurn[],
  events: readonly JsonlEvent[],
): Set<string> {
  const oldestFirst = rows
    .filter(landsAsPrompt)
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const landed = new Set<string>();
  const first = oldestFirst[0];
  if (!first) return landed;
  const since = first.createdAt.getTime();
  const landings = promptLandings(events).filter((at) => at >= since);
  oldestFirst.slice(0, landings.length).forEach((row) => landed.add(row.id));
  return landed;
}
