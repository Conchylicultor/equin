/**
 * The soft edge of the message being written: its newest characters painted
 * fainter, in three tiers by how recently they were revealed, so they fade in
 * as a gradient rather than appear. Painted with the CSS Custom Highlight API —
 * the text is a markdown tree React re-renders on every reveal, and a Highlight
 * paints ranges over it without touching the DOM it reconciles.
 */

/** How long a revealed character takes to reach full colour. */
export const FADE_MS = 360;

/** Faintest first — the `::highlight(stream-tail-N)` rules in stream-tail.css. */
const TIER_NAMES = ["stream-tail-1", "stream-tail-2", "stream-tail-3"] as const;

/**
 * Every live painter's ranges per tier. `CSS.highlights` is one registry per
 * document, and two panes can each be streaming a message.
 */
const painters = new Map<symbol, Range[][]>();

function highlightRegistry(): HighlightRegistry {
  // Supported by every target (Chromium 105, Safari 17.2, Firefox 140).
  if (typeof CSS === "undefined" || !("highlights" in CSS)) {
    throw new Error(
      "streaming text: the CSS Custom Highlight API is unavailable, so the " +
        "message being written cannot be painted",
    );
  }
  return CSS.highlights;
}

function sync(): void {
  const registry = highlightRegistry();
  TIER_NAMES.forEach((name, tier) => {
    const ranges = [...painters.values()].flatMap((r) => r[tier] ?? []);
    if (ranges.length === 0) registry.delete(name);
    else registry.set(name, new Highlight(...ranges));
  });
}

/** The DOM point `fromEnd` characters before the end of `nodes`' text. */
function pointFromEnd(
  nodes: readonly Text[],
  fromEnd: number,
): { node: Text; offset: number } | null {
  let left = fromEnd;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    const len = node.data.length;
    if (left <= len) return { node, offset: len - left };
    left -= len;
  }
  const first = nodes[0];
  return first ? { node: first, offset: 0 } : null;
}

/**
 * Paints `container`'s last characters: `counts[i]` characters in tier `i`,
 * newest (faintest) tier at the very end. The counts are of the source text,
 * a close stand-in for the rendered text a few markdown marks shorter.
 */
export function paintTail(
  key: symbol,
  container: HTMLElement,
  counts: readonly number[],
): void {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    nodes.push(n as Text);
  const tiers: Range[][] = [];
  let end = 0;
  for (const count of counts) {
    const to = pointFromEnd(nodes, end);
    const from = pointFromEnd(nodes, end + count);
    end += count;
    if (!to || !from || count === 0) {
      tiers.push([]);
      continue;
    }
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    tiers.push(range.collapsed ? [] : [range]);
  }
  painters.set(key, tiers);
  sync();
}

export function clearTail(key: symbol): void {
  if (!painters.delete(key)) return;
  sync();
}

export const TIER_COUNT = TIER_NAMES.length;
