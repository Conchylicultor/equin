import { useEffect } from "react";
import type { BlockTextReads } from "../internal/caret-authority";

/**
 * The name the editor's text span is painted under — the one the
 * `::highlight(page-text-span)` rule in `block-selection-scope.css` styles.
 */
const HIGHLIGHT_NAME = "page-text-span";

/** One covered text line of a span: linear `[from, to)`, `to: null` = its end. */
export interface SpanLinePaint {
  id: string;
  from: number;
  to: number | null;
}

/**
 * Every live painter's ranges. `CSS.highlights` is ONE registry per document,
 * and two page panes side by side are two editors that may each hold a span —
 * so each painter owns an entry here and the registered `Highlight` is always
 * the union, rather than the last painter clobbering the other's.
 */
const painters = new Map<symbol, Range[]>();

function highlightRegistry(): HighlightRegistry {
  // Supported by every target (Chromium 105, Safari 17.2, Firefox 140). A
  // browser without it cannot show the span at all, so say so loudly rather
  // than leave a selection the user can act on but not see.
  if (typeof CSS === "undefined" || !("highlights" in CSS)) {
    throw new Error(
      "page editor: the CSS Custom Highlight API is unavailable, so a text " +
        "span cannot be painted",
    );
  }
  return CSS.highlights;
}

function syncRegistry(): void {
  const registry = highlightRegistry();
  const ranges = [...painters.values()].flat();
  if (ranges.length === 0) registry.delete(HIGHLIGHT_NAME);
  else registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

/**
 * Paints an editor-owned text span with the CSS Custom Highlight API.
 *
 * > The span is OFFSETS. A DOM `Range` is derived from them per paint and never
 * > kept as the span's state.
 *
 * Why this API: a span crosses several editing hosts, and a native selection
 * cannot (each host clamps it — the reason the span exists); painting by DOM
 * mutation would fight Lexical's and Yjs's reconciliation. A Highlight paints
 * arbitrary Ranges across hosts with neither.
 *
 * Re-derived whenever a covered line's editor commits an update (local or a
 * remote collab edit), and each derivation clamps the offsets into the text the
 * line holds then (`domRangeOf` clamps) — so an edit that shortened a line can
 * never leave a Range pointing past its end. A line with no mounted text surface
 * is simply not painted.
 *
 * Renders nothing: the highlight lives in the document's registry.
 */
export function TextSpanHighlight({
  lines,
  readsOf,
}: {
  lines: readonly SpanLinePaint[];
  readsOf: (blockId: string) => BlockTextReads | null;
}) {
  useEffect(() => {
    const key = Symbol("text-span");
    const paint = () => {
      const ranges: Range[] = [];
      for (const line of lines) {
        const range = readsOf(line.id)?.domRangeOf?.(
          line.from,
          line.to ?? Number.MAX_SAFE_INTEGER,
        );
        if (range && !range.collapsed) ranges.push(range);
      }
      painters.set(key, ranges);
      syncRegistry();
    };
    paint();
    const unsubscribes = lines.flatMap((line) => {
      const subscribe = readsOf(line.id)?.onTextUpdate;
      return subscribe ? [subscribe(paint)] : [];
    });
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      painters.delete(key);
      syncRegistry();
    };
  }, [lines, readsOf]);
  return null;
}
