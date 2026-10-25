import {
  createTimeSlicer,
  createTurnQueue,
} from "@plugins/packages/plugins/macrotask-yield/core";

// Every transcript parse on this thread takes its turns from one queue: a
// server boot opens many conversations' transcripts at once, and slicers that
// yielded on their own would all resume back to back in one turn — the stall
// again, cut into pieces that still run as one block.
const transcriptTurns = createTurnQueue();

/**
 * A time slicer for one pass over a transcript's lines (decoding a chunk,
 * building the events): `await slice()` per line yields the thread about every
 * 10 ms, on a turn of its own among every other transcript being parsed.
 */
export function transcriptSlicer(): () => Promise<void> {
  return createTimeSlicer(10, transcriptTurns);
}
