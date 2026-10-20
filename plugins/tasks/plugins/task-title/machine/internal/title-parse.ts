// Pure half of title generation: which titles need no model call, and what
// counts as a usable model answer. No I/O, so it is unit-tested directly.

export const SHORT_TITLE_MAX_WORDS = 3;
// What the prompt asks for: the design mock of the short-title list rows
// (prototype proto-1789643584-ldt6) has short titles of 13–27 characters,
// median 17.
export const SHORT_TITLE_TARGET_CHARS = 20;
// The hard bound, above the target so a slightly long answer is kept rather
// than thrown away. Longer is not a short title (one run-on token, a URL, a
// path) — the full title reads better than a truncation of it.
const SHORT_TITLE_MAX_CHARS = 28;
const TITLE_MAX_CHARS = 80;

export type ShortTitleResult =
  { ok: true; shortTitle: string } | { ok: false; reason: string };

/**
 * One model answer, both halves parsed independently: a usable title with an
 * unusable short title (or the reverse) keeps the usable half.
 */
export interface TitlesAnswer {
  /** The full title, or `undefined` when the answer carried none. */
  title: string | undefined;
  short: ShortTitleResult;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * A title that is already short (in words AND characters) is its own short
 * title — no model call. Returns the normalized title, or `undefined` when the
 * title needs shortening.
 */
export function alreadyShort(title: string): string | undefined {
  const w = words(title);
  if (w.length === 0 || w.length > SHORT_TITLE_MAX_WORDS) return undefined;
  const joined = w.join(" ");
  return joined.length > SHORT_TITLE_MAX_CHARS ? undefined : joined;
}

// Wrapping quotes / backticks the model sometimes adds despite the prompt.
const WRAPPING = /^["'`“”‘’«»]+|["'`“”‘’«»]+$/g;

// Wrapping quotes and a trailing period stripped, whitespace collapsed.
function clean(value: string): string {
  return words(
    value
      .trim()
      .replace(WRAPPING, "")
      .trim()
      .replace(/[.。]+$/, ""),
  ).join(" ");
}

/**
 * Validate a short-title candidate: 1–3 words and at most 28 characters;
 * anything else is a failure, and the caller writes nothing (the full title
 * keeps showing).
 */
export function parseShortTitle(raw: string): ShortTitleResult {
  const cleaned = clean(raw);
  const count = words(cleaned).length;
  if (count === 0) return { ok: false, reason: "empty short title" };
  if (count > SHORT_TITLE_MAX_WORDS) {
    return { ok: false, reason: `${count} words: ${cleaned}` };
  }
  if (cleaned.length > SHORT_TITLE_MAX_CHARS) {
    return { ok: false, reason: `${cleaned.length} chars: ${cleaned}` };
  }
  return { ok: true, shortTitle: cleaned };
}

// `TITLE: …` / `SHORT: …`, case-insensitive, optional markdown bold around the
// label (Haiku sometimes adds it).
const LINE = /^\**\s*(title|short)\s*\**\s*:\s*\**\s*(.*)$/i;

/**
 * Parse the two-line `TITLE: …` / `SHORT: …` answer. The first line of each
 * label wins; any other line is ignored. The title is capped at 80 characters.
 */
export function parseTitles(raw: string): TitlesAnswer {
  let title: string | undefined;
  let short: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const label = m[1]!.toLowerCase();
    const value = m[2]!;
    if (label === "title" && title === undefined) title = clean(value);
    if (label === "short" && short === undefined) short = value;
  }
  return {
    title: !title
      ? undefined
      : title.length > TITLE_MAX_CHARS
        ? `${title.slice(0, TITLE_MAX_CHARS - 3)}…`
        : title,
    short:
      short === undefined
        ? { ok: false, reason: "no SHORT line" }
        : parseShortTitle(short),
  };
}
