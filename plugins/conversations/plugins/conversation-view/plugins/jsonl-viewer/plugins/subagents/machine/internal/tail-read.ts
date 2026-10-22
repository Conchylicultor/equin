import {
  lastStepOfLines,
  newestTurnLineAt,
  turnEndedOfLines,
  type LastStep,
} from "../../core";

/** What one bounded read of a transcript's end says about the sub-agent. */
export interface TailReading {
  /** `null` = nothing in the window says anything yet (an empty file at birth). */
  lastStep: LastStep | null;
  /** Its newest turn has ended (`turnEndedOfLines`) — positive evidence only. */
  turnEnded: boolean;
  /** Its newest assistant/user line's own `timestamp` (`newestTurnLineAt`). */
  newestTurnLineAt: string | null;
}

/**
 * How much of a sub-agent transcript's END we read to learn what it last did.
 *
 * The point of the bound: a sub-agent's transcript grows into the megabytes
 * (1.2 MB is ordinary), and the index re-reads on every append. Reading the last
 * 64 KB makes each change cost a constant, tiny read no matter how long the
 * sub-agent has been running — a whole-file parse is what the *pane* does, once,
 * when you open it.
 */
export const TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * What a transcript's last `TAIL_WINDOW_BYTES` say: the most recent classifiable
 * step, whether the newest turn has ended, and when its newest line was written.
 *
 * This half only bounds the read and parses the window, ONCE for both readings;
 * the rules live in core — `lastStepOfLines` (including the one that matters
 * most, that a trailing `tool_result` defers to the `tool_use` it answers rather
 * than quoting its payload) and `turnEndedOfLines`.
 */
export async function readTail(
  path: string,
  size: number,
): Promise<TailReading> {
  const start = Math.max(0, size - TAIL_WINDOW_BYTES);
  const text = await Bun.file(path).slice(start).text();
  const lines = text.split("\n");
  // A window that did not start at byte 0 begins mid-line; that fragment is not
  // parseable JSON and must not be mistaken for a line of its own.
  if (start > 0) lines.shift();

  const parsed: Record<string, unknown>[] = [];
  for (const raw of lines) {
    if (raw === "") continue;
    try {
      parsed.push(JSON.parse(raw) as Record<string, unknown>);
    } catch (err) {
      // A torn final line (Claude appended while we read) is expected; anything
      // else is a real failure.
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return {
    lastStep: lastStepOfLines(parsed),
    turnEnded: turnEndedOfLines(parsed),
    newestTurnLineAt: newestTurnLineAt(parsed),
  };
}
