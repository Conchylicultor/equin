import { z } from "zod";

/**
 * One emoji a user (or a model) picked and something stored — a page icon.
 * Only {@link EmojiSchema} mints it, so a stored value is always exactly one
 * RGI emoji grapheme: never a symbol name, a word, or two emoji.
 */
export type Emoji = string & { readonly __brand: "Emoji" };

// `v` (unicodeSets) is what makes `\p{RGI_Emoji}` — a property of STRINGS
// (ZWJ sequences, flags, keycaps, skin-tone modifiers) — available. Built with
// the constructor because the repo's tsc target (ES2023) rejects a `v` literal;
// Bun (JSC) and every supported browser implement it.
const RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Whether `s` is exactly one emoji: a single grapheme cluster that is an RGI
 * emoji (fully-qualified, so `🗺️` with its VS16 passes and a bare `🗺` does not).
 */
export function isEmoji(s: string): s is Emoji {
  if (s.length === 0) return false;
  const it = graphemes.segment(s)[Symbol.iterator]();
  const first = it.next();
  if (first.done === true || it.next().done !== true) return false;
  return RGI_EMOJI.test(s);
}

/** THE parse that mints an {@link Emoji}. Every store of an emoji decodes through it. */
export const EmojiSchema: z.ZodType<Emoji> = z
  .string()
  .refine(isEmoji, {
    error: (iss) => `"${String(iss.input)}" is not a single emoji`,
  })
  .transform((s) => s as Emoji);
