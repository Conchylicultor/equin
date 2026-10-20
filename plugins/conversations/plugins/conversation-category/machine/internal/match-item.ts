export type ItemMatch =
  { ok: true; item: string } | { ok: false; reason: string };

/**
 * Map a model's free-form answer for one category to one of that category's
 * configured item names. Trims whitespace, surrounding quotes and trailing
 * sentence punctuation, then takes the best case-insensitive match:
 * exact > prefix > substring.
 *
 * No match is a FAILURE, not a value. The previous single-category version fell
 * back to the last configured label ("keep a catch-all at the end"), which
 * per-category is a fabricated classification — "Priority: P0/P1/P2" has no
 * catch-all, and stamping P2 on an unmatched reply invents data the user would
 * read as the model's judgement. Callers write nothing for an unmatched
 * category; the next assistant turn retries it, since "no row yet" is the
 * inclusion predicate. A user who wants a catch-all says so in the category's
 * hint ("if unsure, pick Other").
 */
export function matchItem(
  raw: string,
  itemNames: readonly string[],
): ItemMatch {
  if (itemNames.length === 0) {
    return { ok: false, reason: "category has no configured items" };
  }
  const cleaned = raw
    .trim()
    // strip surrounding quotes the model sometimes adds
    .replace(/^["'`]+|["'`]+$/g, "")
    // strip trailing sentence punctuation
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();

  if (!cleaned) return { ok: false, reason: "empty answer" };

  const lowered = itemNames.map((c) => c.toLowerCase());

  const exactIdx = lowered.indexOf(cleaned);
  if (exactIdx >= 0) return { ok: true, item: itemNames[exactIdx]! };

  const prefixIdx = lowered.findIndex((c) => cleaned.startsWith(c));
  if (prefixIdx >= 0) return { ok: true, item: itemNames[prefixIdx]! };

  const substrIdx = lowered.findIndex(
    (c) => cleaned.includes(c) || c.includes(cleaned),
  );
  if (substrIdx >= 0) return { ok: true, item: itemNames[substrIdx]! };

  return {
    ok: false,
    reason: `no configured item matches ${JSON.stringify(raw.trim())}`,
  };
}
