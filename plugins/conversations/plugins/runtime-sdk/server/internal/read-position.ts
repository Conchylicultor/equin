import { z } from "zod";

/**
 * Where a reader of an agent's events.jsonl stopped: the inode of the file it
 * was reading and the byte offset after the last complete line it took
 * (machine/internal/event-reader.ts). Stored beside the cursor it was read up
 * to, so a restarted backend reads on from there instead of from the oldest
 * generation.
 */
export const ReadPositionSchema = z.object({
  ino: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});
export type ReadPosition = z.infer<typeof ReadPositionSchema>;
