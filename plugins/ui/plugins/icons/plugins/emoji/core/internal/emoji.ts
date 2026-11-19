import { z } from "zod";

/**
 * One emoji a user (or a model) picked and something stored — a page icon.
 * Only {@link EmojiSchema} mints it, so a stored value is always exactly one
 * RGI emoji grapheme: never a symbol name, a word, or two emoji.
 */
export type Emoji = string & { readonly __brand: "Emoji" };

/**
 * Exactly one RGI emoji, exactly: `\p{RGI_Emoji}` is a property of STRINGS
 * (ZWJ sequences, flags, keycaps, skin-tone modifiers), which only the `v`
 * (unicodeSets) flag makes available. Built with the constructor because the
 * repo's tsc target (ES2023) rejects a `v` literal.
 */
const RGI_EMOJI_SOURCE = "^\\p{RGI_Emoji}$";

/** One emoji element of a sequence: fully qualified, so a text-default `🗺` needs its VS16. */
const ELEMENT =
  "(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}|(?!\\p{Regional_Indicator})\\p{Emoji_Presentation}|(?![#*0-9])\\p{Emoji}\\uFE0F)";

/**
 * The same shapes for an engine without `v` (Safari < 17, Firefox < 116 —
 * below equin's browser floor of Safari 16.4 / Firefox 115): UTS #51's emoji
 * sequence grammar spelled with per-character properties under `u` — a flag
 * pair, a keycap, a tag sequence (subdivision flags), or fully-qualified
 * elements joined by ZWJ. It accepts a well-formed sequence Unicode never
 * recommended (an arbitrary ZWJ pair) where `\p{RGI_Emoji}` would not; the
 * server (Bun) always has `v`, so what it stores is RGI-exact.
 */
export const EMOJI_SEQUENCE_SOURCE = `^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F\\u20E3|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]+\\u{E007F}|${ELEMENT}(?:\\u200D${ELEMENT})*)$`;

// Built at module evaluation, so it must not throw on a floor browser: an
// engine without `v` throws "Invalid flags supplied to RegExp constructor"
// here, which failed every importer to load (equin.ai's page editor and
// page-link plugins, Safari 16, 2026-11-19).
const EMOJI =
  "unicodeSets" in RegExp.prototype
    ? new RegExp(RGI_EMOJI_SOURCE, "v")
    : new RegExp(EMOJI_SEQUENCE_SOURCE, "u");

/**
 * Whether `s` is exactly one emoji: the whole string one RGI emoji
 * (fully-qualified, so `🗺️` with its VS16 passes and a bare `🗺` does not).
 * The anchored match is the one-grapheme test: a second emoji, or a letter,
 * leaves the `$` unmatched.
 */
export function isEmoji(s: string): s is Emoji {
  return EMOJI.test(s);
}

/** THE parse that mints an {@link Emoji}. Every store of an emoji decodes through it. */
export const EmojiSchema: z.ZodType<Emoji> = z
  .string()
  .refine(isEmoji, {
    error: (iss) => `"${String(iss.input)}" is not a single emoji`,
  })
  .transform((s) => s as Emoji);
