import type { BacklinkSnippet } from "../../core";

/** Roughly how many characters of context a snippet keeps around its match. */
export const SNIPPET_CONTEXT = 80;

const ELLIPSIS = "…";

/**
 * The excerpt of one linking block that a backlink row shows: `text` (the
 * block's plain text as a person reads it — inline tokens already replaced by
 * their titles) split around the first occurrence of `title`, with about
 * {@link SNIPPET_CONTEXT} characters of context kept in all, cut on a word
 * boundary where one is near and marked with `…`.
 *
 * `null` when there is nothing to excerpt beyond the link itself:
 *  - the text does not contain the title (a block whose link is not in its
 *    text — a page-link block has no text at all), or
 *  - the text IS the title (the whole block is the link).
 *
 * Whitespace runs (newlines included) collapse to one space: a snippet is one
 * line.
 */
export function deriveSnippet(
  text: string,
  title: string,
): BacklinkSnippet | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const match = title.replace(/\s+/g, " ").trim();
  if (match === "") return null;
  const at = flat.indexOf(match);
  if (at < 0) return null;
  const rawBefore = flat.slice(0, at);
  const rawAfter = flat.slice(at + match.length);
  if (rawBefore.trim() === "" && rawAfter.trim() === "") return null;

  // Split the budget evenly; a side that needs less hands the rest over.
  const half = Math.floor(SNIPPET_CONTEXT / 2);
  const beforeBudget = Math.max(half, SNIPPET_CONTEXT - rawAfter.length);
  const afterBudget = Math.max(half, SNIPPET_CONTEXT - rawBefore.length);
  return {
    before: keepTail(rawBefore, beforeBudget),
    match,
    after: keepHead(rawAfter, afterBudget),
  };
}

/** The last ~`budget` characters of `s`, starting on a word. */
function keepTail(s: string, budget: number): string {
  if (s.length <= budget) return s;
  const cut = s.slice(s.length - budget);
  const space = cut.indexOf(" ");
  // A word boundary near the cut keeps whole words; with none (one long word)
  // the cut stands.
  const start = space >= 0 && space < budget / 2 ? space + 1 : 0;
  return ELLIPSIS + cut.slice(start);
}

/** The first ~`budget` characters of `s`, ending on a word. */
function keepHead(s: string, budget: number): string {
  if (s.length <= budget) return s;
  const cut = s.slice(0, budget);
  const space = cut.lastIndexOf(" ");
  const end = space > budget / 2 ? space : budget;
  return cut.slice(0, end) + ELLIPSIS;
}
