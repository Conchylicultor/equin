import {
  $createTextNode,
  $getSelection,
  $hasUpdateTag,
  $isDecoratorNode,
  $isRangeSelection,
  $isTextNode,
  COLLABORATION_TAG,
  TextNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
} from "lexical";
import {
  matchTokens,
  type InlineTokenExtension,
} from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";

/**
 * Keep every inline token readable back from the text it serializes to.
 *
 * A token node is written out as its token text, concatenated with whatever
 * sits beside it. Two id chips side by side serialize to
 * `proto-…-x9vkproto-…-g9ical`, which the id pattern's boundary guards read as
 * NO id at all — the chips silently became prose the moment the value was
 * saved. The same happens to a chip with a letter typed right after it.
 *
 * So the invariant enforced here is the round trip itself: serializing a token
 * next to its neighbour, and scanning the result, must give back that token.
 * When it does not, a single space goes between them — real content, so what
 * the editor shows is what gets saved, and the value ↔ offset mapping stays
 * exact.
 *
 * The scan is the oracle, never a hand-written "word character" rule: each
 * family decides for itself what may touch it (an id needs a gap, a
 * `<ui-context …/>` tag does not), and a future family is covered with no
 * wiring.
 *
 * Every way a token gets beside something — a paste, a caret insert, a drop,
 * typing next to a chip, deleting the space between two — dirties the token or
 * its neighbour, so node transforms on the token classes and on `TextNode`
 * cover them all.
 *
 * A remote (collaboration) update is left alone: its author's editor already
 * separated it, and repairing it again on every peer would insert one space per
 * peer.
 */
export function registerTokenBoundaries(
  editor: LexicalEditor,
  extensions: readonly InlineTokenExtension[],
): () => void {
  const transform = (node: LexicalNode): void => {
    if ($hasUpdateTag(COLLABORATION_TAG)) return;
    $separateFromNeighbours(node, extensions);
  };
  const classes = new Map<string, Klass<LexicalNode>>();
  for (const ext of extensions) classes.set(ext.node.type, ext.node.Node);
  const unregister = [TextNode, ...classes.values()].map((klass) =>
    editor.registerNodeTransform(klass, transform),
  );
  return () => {
    for (const fn of unregister) fn();
  };
}

/** Separate `node` from each neighbour it would fuse with. In an update. */
export function $separateFromNeighbours(
  node: LexicalNode,
  extensions: readonly InlineTokenExtension[],
): void {
  const prev = node.getPreviousSibling();
  if (prev) $separatePair(prev, node, extensions);
  const next = node.getNextSibling();
  if (next) $separatePair(node, next, extensions);
}

function $separatePair(
  left: LexicalNode,
  right: LexicalNode,
  extensions: readonly InlineTokenExtension[],
): void {
  const l = $rawText(left, extensions);
  const r = $rawText(right, extensions);
  if (l === null || r === null || l.length === 0 || r.length === 0) return;
  if (!l.token && !r.token) return;
  if (readsBack(l, r, "", extensions)) return;
  // A family that a space cannot separate either is left as it is: inserting
  // would not help, and would never stop.
  if (!readsBack(l, r, " ", extensions)) return;

  const selection = $getSelection();
  const atJoint =
    $isRangeSelection(selection) &&
    selection.isCollapsed() &&
    $isAtJoint(selection.anchor, left, right);
  const space = $createTextNode(" ");
  if ($isTextNode(left)) space.setFormat(left.getFormat());
  else if ($isTextNode(right)) space.setFormat(right.getFormat());
  left.insertAfter(space);
  // A caret at the joint stays before the space: deleting the space between a
  // chip and its text puts it right back, and leaving the caret after it would
  // make that Backspace a no-op forever. Before it, the next Backspace reaches
  // the chip.
  if (atJoint) space.select(0, 0);
}

interface RawText {
  text: string;
  token: boolean;
  length: number;
}

/**
 * What `node` contributes to the serialized line: its token text, or a text
 * node's characters. `null` for anything else (a line break, an element) —
 * those are not concatenated with their neighbours.
 */
function $rawText(
  node: LexicalNode,
  extensions: readonly InlineTokenExtension[],
): RawText | null {
  if ($isTextNode(node)) {
    const text = node.getTextContent();
    return { text, token: false, length: text.length };
  }
  if (!$isDecoratorNode(node)) return null;
  for (const ext of extensions) {
    const text = ext.serializeNode(node);
    if (text !== null) return { text, token: true, length: text.length };
  }
  return null;
}

/** Does every token side come back as itself from `l + gap + r`? */
function readsBack(
  l: RawText,
  r: RawText,
  gap: string,
  extensions: readonly InlineTokenExtension[],
): boolean {
  const joined = l.text + gap + r.text;
  const matches = matchTokens(joined, undefined, extensions);
  const has = (start: number, end: number) =>
    matches.some((m) => m.start === start && m.end === end);
  return (
    (!l.token || has(0, l.length)) &&
    (!r.token || has(joined.length - r.length, joined.length))
  );
}

function $isAtJoint(
  point: PointType,
  left: LexicalNode,
  right: LexicalNode,
): boolean {
  if (point.type === "text") {
    if (point.key === left.getKey()) {
      return point.offset === left.getTextContentSize();
    }
    return point.key === right.getKey() && point.offset === 0;
  }
  return (
    point.key === right.getParent()?.getKey() &&
    point.offset === right.getIndexWithinParent()
  );
}
