/**
 * A one-shot request to insert text into an open (or about-to-open) draft form.
 *
 * The `id` — not the text — is the applied-once key, which is what makes this a
 * *request* rather than a seed value. That distinction is load-bearing: a plain
 * `initialText` string silently no-ops when the same snippet is requested twice
 * (React sees an unchanged prop) and re-applies itself on every remount, because
 * the value is indistinguishable from the state it produced.
 *
 * The id is minted here rather than by the caller so two independent callers can
 * never collide, and so "each call is a distinct request" is a property of the
 * type instead of a convention consumers have to keep.
 */
export interface TaskDraftInsert {
  readonly id: number;
  readonly text: string;
  /**
   * `add` (an attachment: a picked element, a screenshot) is added to whatever
   * is drafted. `seed` (a suggested first request) is a starting point, so it
   * lands only in an EMPTY draft — never mixed into work in progress.
   */
  readonly mode: "add" | "seed";
}

let seq = 0;

/** Mint an insertion request for `text`. Every call is a distinct request. */
export function draftInsert(text: string): TaskDraftInsert {
  seq += 1;
  return { id: seq, text, mode: "add" };
}

/**
 * Mint a seed request: `text` fills the head card only when nothing is
 * drafted (every card empty); otherwise the draft is kept as it is.
 */
export function draftSeed(text: string): TaskDraftInsert {
  seq += 1;
  return { id: seq, text, mode: "seed" };
}

/**
 * Append `snippet` to `text` as its own paragraph. The fallback used when no
 * editor is mounted to take the snippet at a caret (popover still closed, or the
 * form is behind its loading state) — so a programmatic insert lands in the draft
 * either way, and never as a replacement.
 */
export function appendSnippet(text: string, snippet: string): string {
  if (!text) return snippet;
  return `${text.replace(/\n+$/, "")}\n\n${snippet}`;
}
