import { z } from "zod";

/** The longest item: one plain sentence, read at a glance. */
export const FLAG_ITEM_MAX_CHARS = 100;

/**
 * What a flag says, split by who reads it how (`flag_raise`'s input, the
 * `conversation_flags` row, the `conversation.flagRaised` payload):
 *
 * - `items` — what the user must act on or decide, one plain sentence each,
 *   read at a glance with no context. Each is bounded in length, so an item
 *   cannot be a paragraph; how many there are is what the work left.
 * - `details` — the evidence behind them (errors, ids, paths, what was
 *   checked) and notes that need no action; drawn folded.
 */
export const FlagItemsSchema = z
  .array(z.string().trim().min(1).max(FLAG_ITEM_MAX_CHARS))
  .min(1);

export const FlagSchema = z.object({
  items: FlagItemsSchema,
  details: z.string().trim().min(1).nullable(),
});
export type Flag = z.infer<typeof FlagSchema>;
