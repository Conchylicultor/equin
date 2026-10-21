// The first line of a successful places_search_text answer, written by the
// server and read back by the step label ("→ 12 places") — one spelling.

export function searchCountLine(count: number): string {
  return count === 0 ? "No places found." : `${count} places:`;
}

/** How many places a search answer listed; null when it is not one (an error). */
export function searchCountOf(content: string): number | null {
  if (/^No places found\.$/m.test(content)) return 0;
  const m = /^(\d+) places:$/m.exec(content);
  return m === null ? null : Number(m[1]);
}
