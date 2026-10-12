import { mergeRuns, splitRuns, type RichText, type TextRun } from "./rich-text";

/**
 * One end of an editor-owned text span: a linear offset in a block's text, in
 * the STORED-RUNS basis (`splitRuns` / `runsLength` / the editor's
 * `$linearOffsetOfPoint`), so it addresses the same character on screen, in
 * the doc and in the row.
 */
export interface SpanPoint {
  blockId: string;
  offset: number;
}

/**
 * The block list as {@link normalizeSpan} reads it.
 *
 * `order` is every VISIBLE line in document order — the same flatten the
 * surface renders and the reducer's `nextVisibleLine` walks — with the page
 * that owns it (`group`). A span is ONE page's op (`deleteSpan` is committed in
 * one page's transaction), so a span whose ends, or any line between them,
 * belong to different pages cannot be one.
 *
 * `textOf` is asked only for the two ENDS, never for every line, so a pointer
 * extending the span at 60fps reads two blocks per move, not the page. It
 * answers the line's live plain text when the line can be a span end — a
 * text-bearing block that is neither a page row nor a container anchor, i.e.
 * one `deleteSpan` can merge into or away — and `null` otherwise.
 */
export interface SpanLines {
  order: readonly { id: string; group: string | null }[];
  textOf: (id: string) => string | null;
  /**
   * The inline token patterns (chips, dates, inline math — the editor's
   * `blockTextProtectedSpans()`). A token is one atom in `TextRun.text`, so an
   * end falling strictly inside one is snapped OUTWARD: the span covers the
   * whole token or none of it, and a cut can never split one.
   */
  tokenPatterns?: readonly RegExp[];
}

/**
 * What a pointer or keyboard gesture over the block list resolves to.
 *
 * - `text` — an editor-owned span with partial ends. Both ends are text-bearing
 *   mergeable lines (that is what {@link normalizeSpan} guarantees, and why no
 *   consumer has to re-check it). `from` / `to` are the two ends in document
 *   order; `anchor` / `head` keep the direction the gesture drew it in. A span
 *   whose ends sit in ONE block is legal — it is what a drag that returns into
 *   its origin row resolves to.
 * - `blocks` — the span cannot be a text span (an end on a text-less line, or a
 *   span crossing a page boundary), so it widens to the whole-block range
 *   between the two lines.
 * - `none` — an end names no visible line.
 */
export type SpanSelection =
  | {
      kind: "text";
      anchor: SpanPoint;
      head: SpanPoint;
      from: SpanPoint;
      to: SpanPoint;
    }
  | { kind: "blocks"; anchor: string; head: string }
  | { kind: "none" };

/**
 * THE constructor of a text span. Every `text` selection the editor holds was
 * made here, so the properties below are true of all of them:
 *
 * 1. Its ends are ordered (`from` precedes `to` in visible order, or sits at a
 *    lower offset in the same block).
 * 2. Both ends are text-bearing, mergeable lines of ONE page — an end on a
 *    text-less line (an image, a divider, a page row, a container anchor), or a
 *    span crossing into another page, widens the whole thing to `blocks`.
 * 3. Each offset is clamped into its line's text and snapped outward off any
 *    token it would split.
 */
export function normalizeSpan(
  anchor: SpanPoint,
  head: SpanPoint,
  lines: SpanLines,
): SpanSelection {
  const index = new Map(lines.order.map((l, i) => [l.id, i]));
  const ai = index.get(anchor.blockId);
  const hi = index.get(head.blockId);
  if (ai === undefined || hi === undefined) return { kind: "none" };
  const widened = {
    kind: "blocks",
    anchor: anchor.blockId,
    head: head.blockId,
  } as const;

  const lo = Math.min(ai, hi);
  const hiIdx = Math.max(ai, hi);
  const group = lines.order[lo]!.group;
  for (let i = lo + 1; i <= hiIdx; i++) {
    if (lines.order[i]!.group !== group) return widened;
  }

  const anchorText = lines.textOf(anchor.blockId);
  const headText =
    head.blockId === anchor.blockId ? anchorText : lines.textOf(head.blockId);
  if (anchorText === null || headText === null) return widened;

  const forward = ai < hi || (ai === hi && anchor.offset <= head.offset);
  const patterns = lines.tokenPatterns ?? [];
  // Outward: the lower end snaps DOWN to a token's start, the upper end UP to
  // its end, so a partially-covered token is covered whole.
  const snapped = (p: SpanPoint, text: string, edge: "start" | "end") => ({
    blockId: p.blockId,
    offset: snapOffToken(clamp(p.offset, text.length), text, patterns, edge),
  });
  const a = snapped(anchor, anchorText, forward ? "start" : "end");
  const h = snapped(head, headText, forward ? "end" : "start");
  return {
    kind: "text",
    anchor: a,
    head: h,
    from: forward ? a : h,
    to: forward ? h : a,
  };
}

/**
 * One keyboard step of a span's moving end inside `text`: `offset` moved by one
 * CARET position toward `dir`, or null at the text's edge in that direction
 * (the step then crosses into the neighbouring line — the caller's business).
 *
 * A caret position, not a code unit: an inline token (`tokenPatterns`, the
 * same set {@link normalizeSpan} snaps off) is one atom on screen, so a step
 * that would enter one jumps over it whole, and a surrogate pair is one
 * character. Stepping by one code unit instead would land INSIDE a token,
 * which `normalizeSpan` then snaps back outward — and a shrinking end would
 * be pushed back where it started, never getting past the token.
 */
export function stepTextOffset(
  text: string,
  offset: number,
  dir: "left" | "right",
  tokenPatterns: readonly RegExp[] = [],
): number | null {
  const at = clamp(offset, text.length);
  if (dir === "left" ? at === 0 : at === text.length) return null;
  for (const pattern of tokenPatterns) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (const m of text.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      if (dir === "right" && at >= from && at < to) return to;
      if (dir === "left" && at > from && at <= to) return from;
    }
  }
  if (dir === "right") {
    const code = text.charCodeAt(at);
    const pair = code >= 0xd800 && code <= 0xdbff && at + 1 < text.length;
    return at + (pair ? 2 : 1);
  }
  const code = text.charCodeAt(at - 1);
  const pair = code >= 0xdc00 && code <= 0xdfff && at - 2 >= 0;
  return at - (pair ? 2 : 1);
}

function clamp(offset: number, length: number): number {
  return Math.max(0, Math.min(offset, length));
}

/**
 * `offset` moved off the inside of any token in `text`: to the token's start
 * for the span's `start` end, to its end for the `end` end. An offset ON a
 * token boundary is already a legal cut and is returned as is.
 */
function snapOffToken(
  offset: number,
  text: string,
  patterns: readonly RegExp[],
  edge: "start" | "end",
): number {
  for (const pattern of patterns) {
    const re = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (const m of text.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      if (offset > from && offset < to) return edge === "start" ? from : to;
    }
  }
  return offset;
}

/**
 * The text a span leaves on its start line: the start line's runs up to the
 * span's start, joined to the end line's runs after the span's end. The ONE
 * derivation of the `deleteSpan` op's `runs`, of the doc splice that carries
 * them into the start line's content doc, and (the same block twice) of a
 * span inside one line — so the row, the doc and the caret cannot disagree
 * about where the join is.
 */
export function joinAroundSpan(
  fromRuns: RichText,
  fromOffset: number,
  toRuns: RichText,
  toOffset: number,
  /**
   * Text that REPLACES the span (a character typed over it), between the two
   * halves. It is typed where the span starts, so it takes what typing there
   * would: the marks and colour of the text just before it (not its link — a
   * caret at a link's end types outside it).
   */
  typed?: string,
): RichText {
  const head = splitRuns(fromRuns, fromOffset)[0];
  const tail = splitRuns(toRuns, toOffset)[1];
  if (!typed) return mergeRuns(head, tail);
  const before = head.at(-1);
  const run: TextRun = { text: typed };
  if (before?.marks?.length) run.marks = before.marks;
  if (before?.color) run.color = before.color;
  return mergeRuns(mergeRuns(head, [run]), tail);
}
