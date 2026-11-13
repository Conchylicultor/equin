import { z } from "zod";

/** The most items one flag holds: what needs the user, never a report. */
export const FLAG_MAX_ITEMS = 4;
/** The longest item: one plain sentence, read at a glance. */
export const FLAG_ITEM_MAX_CHARS = 100;

/**
 * What a flag says, split by who reads it how (`flag_raise`'s input, the
 * `conversation_flags` row, the `conversation.flagRaised` payload):
 *
 * - `items` — what the user must act on or decide, one plain sentence each,
 *   read at a glance with no context. Bounded in count and length, so a flag
 *   cannot be a wall of text.
 * - `details` — the evidence behind them (errors, ids, paths, what was
 *   checked) and notes that need no action; drawn folded.
 */
export const FlagItemsSchema = z
  .array(z.string().trim().min(1).max(FLAG_ITEM_MAX_CHARS))
  .min(1)
  .max(FLAG_MAX_ITEMS);

export const FlagSchema = z.object({
  items: FlagItemsSchema,
  details: z.string().trim().min(1).nullable(),
});
export type Flag = z.infer<typeof FlagSchema>;
