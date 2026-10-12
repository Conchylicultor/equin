import type {
  Score,
  SectionAnnotation,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * Pure section lookups for the progress bar's chapters, labels and hover line.
 * No React here: every function is a plain projection of a Score's `section`
 * annotations, tested beside this file.
 */

/**
 * The dot fills, one per themeable categorical token. Literal strings so
 * Tailwind sees every class; `categorical-10` (the neutral grey) is left out —
 * a grey dot would read as "inactive", not as one more section kind.
 */
export const SECTION_DOT_CLASSES = [
  "bg-categorical-1",
  "bg-categorical-2",
  "bg-categorical-3",
  "bg-categorical-4",
  "bg-categorical-5",
  "bg-categorical-6",
  "bg-categorical-7",
  "bg-categorical-8",
  "bg-categorical-9",
] as const;

const sortedCache = new WeakMap<Score, readonly SectionAnnotation[]>();

/** The score's `section` annotations, sorted by start (memoized per score). */
export function sectionsOf(score: Score): readonly SectionAnnotation[] {
  const cached = sortedCache.get(score);
  if (cached) return cached;
  const sections = score.annotations
    .filter((a): a is SectionAnnotation => a.type === "section")
    .sort((a, b) => a.start - b.start);
  sortedCache.set(score, sections);
  return sections;
}

/** The section whose `[start, end)` holds `beat` (the later one on overlap). */
export function sectionAt(
  sections: readonly SectionAnnotation[],
  beat: number,
): SectionAnnotation | undefined {
  return sections.findLast((s) => beat >= s.start && beat < s.end);
}

/**
 * A section's kind: the name without trailing digits/whitespace, lower-cased —
 * so "Chorus", "chorus 2" and "Chorus2" are one kind and share a colour.
 */
export function sectionKind(name: string): string {
  return name
    .replace(/[\s\d]+$/, "")
    .trim()
    .toLowerCase();
}

/** Deterministic index in `[0, count)` for a section name, by its kind. */
export function sectionColorIndex(name: string, count: number): number {
  // FNV-1a over the kind: stable across sessions and songs.
  let hash = 0x811c9dc5;
  for (const ch of sectionKind(name)) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % count;
}

/** The dot fill class for a section name. */
export function sectionDotClass(name: string): string {
  const cls =
    SECTION_DOT_CLASSES[sectionColorIndex(name, SECTION_DOT_CLASSES.length)];
  // sectionColorIndex is always in range; a miss means the palette is empty.
  if (cls === undefined) throw new Error("SECTION_DOT_CLASSES is empty");
  return cls;
}
