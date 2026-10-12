import {
  normalizeSpan,
  plainOf,
  stepTextOffset,
  type SpanLines,
  type SpanPoint,
  type SpanSelection,
} from "../../core";
import type { BlockTextReads } from "./caret-authority";

/** Which way a keyboard gesture moves a span's head. */
export type SpanDir = "left" | "right" | "up" | "down";

/**
 * How the keyboard moves an editor-owned text span — the reads the block list
 * supplies (its rendered lines and their text surfaces), handed to
 * `use-block-selection` as one capability so that hook stays free of DOM
 * geometry and of the editor's registries.
 */
export interface SpanMotion {
  /**
   * Where a span drawn out of `blockId`'s text in `dir` puts its head: the
   * neighbouring line's near edge — its end (left), its start (right), or the
   * point at viewport column `x` on its last (up) / first (down) visual line.
   * Null when there is no line that way. A text-less neighbour still answers
   * (offset 0): `normalize` widens the selection to blocks on it.
   */
  enter: (blockId: string, dir: SpanDir, x: number) => SpanPoint | null;
  /**
   * One keyboard step of a span's head: one caret position (left / right,
   * crossing into the neighbouring line at an edge) or one visual line (up /
   * down, at column `goalX` when the gesture has one, crossing into the
   * neighbour's edge line from the head's edge line). `x` is the column the
   * step resolved at, for the next vertical step to keep. Null when the head
   * cannot move (the document's first / last position).
   */
  step: (
    head: SpanPoint,
    dir: SpanDir,
    goalX: number | null,
  ) => { head: SpanPoint; x: number | null } | null;
  /** `normalizeSpan` over the rendered lines — THE constructor of a span. */
  normalize: (anchor: SpanPoint, head: SpanPoint) => SpanSelection;
}

/** The block list as {@link createSpanMotion} reads it. */
export interface SpanMotionLines extends SpanLines {
  /**
   * Whether a rendered row paints a LINE of its own. A container anchor with
   * visible children is zero-height (its first line is its first child's), so
   * the keyboard steps past it rather than onto it.
   */
  paintsLine: (id: string) => boolean;
  /** The row's mounted text surface, or null (a void row, an unmounted one). */
  readsOf: (id: string) => BlockTextReads | null;
}

/** A visual line of a block's text: its vertical extent and horizontal span. */
interface LineBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The visual lines of `[0, len)` in a text surface, top to bottom — each the
 * union of the client rects sharing one line box. Empty when nothing is
 * painted (an empty line paints no text rects: the caller falls back to the
 * structural answer).
 */
function linesOf(reads: BlockTextReads, len: number): LineBox[] {
  const range = reads.domRangeOf?.(0, len);
  if (!range) return [];
  const rects = [...range.getClientRects()].filter((r) => r.height > 0);
  if (rects.length === 0) {
    const box = range.getBoundingClientRect();
    return box.height > 0
      ? [{ top: box.top, bottom: box.bottom, left: box.left, right: box.right }]
      : [];
  }
  rects.sort((a, b) => a.top - b.top);
  const lines: LineBox[] = [];
  for (const r of rects) {
    const line = lines.at(-1);
    // Same line box: the rects overlap vertically.
    if (line && r.top < line.bottom && r.bottom > line.top) {
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
    } else {
      lines.push({
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
      });
    }
  }
  return lines;
}

/** The viewport point of linear `offset` in a text surface, or null. */
function pointOf(
  reads: BlockTextReads,
  offset: number,
): { x: number; y: number } | null {
  const range = reads.domRangeOf?.(offset, offset);
  if (!range) return null;
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0 && rect.top === 0) return null;
  return { x: rect.left, y: rect.top + rect.height / 2 };
}

/**
 * The offset at column `x` on `line`, the x clamped into the line's painted
 * extent (a column past a short line's end is that line's end) — the same hit
 * test a vertical caret crossing uses.
 */
function offsetOnLine(
  reads: BlockTextReads,
  line: LineBox,
  x: number,
): number | null {
  const cx = Math.min(Math.max(x, line.left + 1), line.right - 1);
  return reads.offsetAtPoint?.(cx, (line.top + line.bottom) / 2) ?? null;
}

/**
 * The span-motion capability over the rendered lines `lines` (re-created
 * whenever they change; it holds nothing). Pure DOM reads: it never moves a
 * caret or a selection.
 */
export function createSpanMotion(lines: SpanMotionLines): SpanMotion {
  const ids = lines.order.map((l) => l.id);
  const tokens = lines.tokenPatterns ?? [];

  const textOf = (id: string): string => {
    const read = lines.readsOf(id)?.readRuns;
    return read ? plainOf(read()) : "";
  };

  /** The next row painting a line in `dir` from `id`, or null. */
  const neighbour = (id: string, forward: boolean): string | null => {
    const at = ids.indexOf(id);
    if (at === -1) return null;
    for (let i = at + (forward ? 1 : -1); i >= 0 && i < ids.length;) {
      const candidate = ids[i]!;
      if (lines.paintsLine(candidate)) return candidate;
      i += forward ? 1 : -1;
    }
    return null;
  };

  /** The point at column `x` on `id`'s first / last visual line. */
  const edgePoint = (
    id: string,
    edge: "first" | "last",
    x: number,
  ): SpanPoint => {
    const reads = lines.readsOf(id);
    // A text-less row: its one position. `normalize` widens on it.
    if (!reads) return { blockId: id, offset: 0 };
    const len = textOf(id).length;
    const boxes = linesOf(reads, len);
    const line = edge === "first" ? boxes[0] : boxes.at(-1);
    const hit = line ? offsetOnLine(reads, line, x) : null;
    return {
      blockId: id,
      offset: hit ?? (edge === "first" ? 0 : len),
    };
  };

  return {
    enter(blockId, dir, x) {
      const next = neighbour(blockId, dir === "right" || dir === "down");
      if (next === null) return null;
      if (dir === "left") return { blockId: next, offset: textOf(next).length };
      if (dir === "right") return { blockId: next, offset: 0 };
      return edgePoint(next, dir === "up" ? "last" : "first", x);
    },

    step(head, dir, goalX) {
      if (dir === "left" || dir === "right") {
        const text = textOf(head.blockId);
        const moved = stepTextOffset(text, head.offset, dir, tokens);
        if (moved !== null)
          return { head: { blockId: head.blockId, offset: moved }, x: null };
        const next = neighbour(head.blockId, dir === "right");
        if (next === null) return null;
        return {
          head: {
            blockId: next,
            offset: dir === "right" ? 0 : textOf(next).length,
          },
          x: null,
        };
      }

      const forward = dir === "down";
      const reads = lines.readsOf(head.blockId);
      const len = textOf(head.blockId).length;
      const at = reads ? pointOf(reads, head.offset) : null;
      const x = goalX ?? at?.x ?? 0;
      if (reads && at) {
        const boxes = linesOf(reads, len);
        const index = boxes.findIndex((l) => at.y >= l.top && at.y <= l.bottom);
        const target =
          index === -1 ? undefined : boxes[index + (forward ? 1 : -1)];
        if (target) {
          const hit = offsetOnLine(reads, target, x);
          if (hit !== null)
            return { head: { blockId: head.blockId, offset: hit }, x };
        }
      }
      // No line beyond the head's own in this block: the neighbour's edge line.
      const next = neighbour(head.blockId, forward);
      if (next === null) {
        // The document's edge: the head goes to its own line's far end, as a
        // caret's Shift+Up on the first line goes to its start.
        const offset = forward ? len : 0;
        if (offset === head.offset) return null;
        return { head: { blockId: head.blockId, offset }, x };
      }
      return { head: edgePoint(next, forward ? "first" : "last", x), x };
    },

    normalize(anchor, head) {
      return normalizeSpan(anchor, head, lines);
    },
  };
}
