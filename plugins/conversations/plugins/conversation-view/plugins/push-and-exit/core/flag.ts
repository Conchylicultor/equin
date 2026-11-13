import { z } from "zod";

/** The longest item text: one plain sentence, read at a glance. */
export const FLAG_ITEM_MAX_CHARS = 100;

/** The longest category: a word or two (`bug`, `caveat`, `decision`). */
export const FLAG_CATEGORY_MAX_CHARS = 20;

/**
 * One thing the user must act on or decide: its free-form `category` (a
 * word or two, drawn as a chip before it); `text`, one plain
 * sentence read at a glance with no context (bounded in length, so it cannot
 * be a paragraph); and optionally `detail` — the context behind that one item
 * (errors, ids, paths, what was checked), drawn folded under it.
 */
export const FlagItemSchema = z.object({
  category: z.string().trim().min(1).max(FLAG_CATEGORY_MAX_CHARS),
  text: z.string().trim().min(1).max(FLAG_ITEM_MAX_CHARS),
  detail: z.string().trim().min(1).optional(),
});
export type FlagItem = z.infer<typeof FlagItemSchema>;

/** How many items there are is what the work left. */
export const FlagItemsSchema = z.array(FlagItemSchema).min(1);

/**
 * What a flag says, split by who reads it how (`flag_raise`'s input, the
 * `conversation_flags` row, the `conversation.flagRaised` payload):
 *
 * - `items` — what the user must act on or decide, each with its own folded
 *   detail when it has one.
 * - `details` — notes that belong to no one item and need no action; drawn
 *   folded under the items.
 */
export const FlagSchema = z.object({
  items: FlagItemsSchema,
  details: z.string().trim().min(1).nullable(),
});
export type Flag = z.infer<typeof FlagSchema>;
