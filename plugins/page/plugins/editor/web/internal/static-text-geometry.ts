// Caret geometry over a DORMANT line — a text block drawn as static DOM
// (`StaticBlockText`) instead of a live Lexical editor.
//
// Offsets are the stored-runs linear basis every live reader uses
// (`caret-geometry.ts`'s `$linearOffsetOfPoint` / `$resolveLinearOffset`): a
// character counts one, a soft line break (`<br>`) one, and an inline token its
// WHOLE spelling, as one atomic leaf — the length Lexical's decorator node
// reports. `RunsRenderer` marks each token with `TOKEN_LENGTH_ATTR`, and an
// empty line's placeholder `<br>` with `EMPTY_LINE_ATTR` (it holds no
// character). So a span painted over a dormant line, a drag anchored in one,
// and the caret that lands when it wakes all name the same positions the live
// editor would.

import { TOKEN_LENGTH_ATTR } from "../components/runs-renderer";
import { caretFromPoint } from "./caret-geometry";

/**
 * Marks a text block's VISIBLE text root — its static line, or its live
 * editor once that is on screen — so a reader of "the line's text" (an e2e
 * script, a probe) finds exactly one per block either way.
 */
export const BLOCK_TEXT_ATTR = "data-block-text";

/** Marks the `<br>` an empty dormant line renders to keep its height. */
export const EMPTY_LINE_ATTR = "data-empty-line";

/** One atomic leaf's length, or null for a node whose children carry the text. */
function leafLength(node: Node): number | null {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = node as Element;
  const token = el.getAttribute(TOKEN_LENGTH_ATTR);
  if (token !== null) return Number(token);
  if (el.tagName === "BR") return el.hasAttribute(EMPTY_LINE_ATTR) ? 0 : 1;
  return null;
}

/** The text's total linear length. */
export function staticTextLength(root: Node): number {
  let total = 0;
  const walk = (n: Node): void => {
    const len = leafLength(n);
    if (len !== null) {
      total += len;
      return;
    }
    n.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return total;
}

/** The atomic token element `node` sits inside (itself included), if any. */
function tokenOf(root: Node, node: Node): Element | null {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
    if (
      n.nodeType === Node.ELEMENT_NODE &&
      (n as Element).hasAttribute(TOKEN_LENGTH_ATTR)
    )
      return n as Element;
  }
  return null;
}

/** Linear length of everything before `target` in document order under `root`. */
function offsetBefore(root: Node, target: Node): number | null {
  let acc = 0;
  let found = false;
  const walk = (n: Node): void => {
    if (found) return;
    if (n === target) {
      found = true;
      return;
    }
    const len = leafLength(n);
    if (len !== null) {
      acc += len;
      return;
    }
    for (const child of Array.from(n.childNodes)) {
      walk(child);
      if (found) return;
    }
  };
  for (const child of Array.from(root.childNodes)) {
    walk(child);
    if (found) break;
  }
  return found ? acc : null;
}

/**
 * The linear offset of the DOM point `(node, offset)` — a selection's anchor or
 * focus, a hit-test — or null when it is not inside `root`. A point inside a
 * token resolves to the token's start (`after` = its end).
 */
export function staticOffsetOfDomPoint(
  root: Node,
  node: Node,
  offset: number,
  after = false,
): number | null {
  if (node !== root && !root.contains(node)) return null;
  const token = tokenOf(root, node);
  if (token) {
    const start = offsetBefore(root, token);
    if (start === null) return null;
    return after ? start + (leafLength(token) ?? 0) : start;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const start = offsetBefore(root, node);
    if (start === null) return null;
    return start + Math.min(offset, (node as Text).data.length);
  }
  // An element point: before its `offset`-th child.
  const children = node.childNodes;
  if (offset < children.length) {
    return node === root
      ? (offsetBefore(root, children[offset]!) ?? 0)
      : offsetBefore(root, children[offset]!);
  }
  // Past the last child: everything up to and inside this element.
  const start = node === root ? 0 : offsetBefore(root, node);
  if (start === null) return null;
  return start + staticTextLength(node);
}

/**
 * The linear offset of the insertion point under the viewport point `(x, y)`,
 * or null when the point resolves outside `root`. A hit on a token lands
 * before or after it by the side the point fell on — `linearOffsetAtPoint`'s
 * rule for a decorator.
 */
export function staticOffsetAtPoint(
  root: Element,
  x: number,
  y: number,
): number | null {
  const hit = caretFromPoint(x, y);
  if (!hit || !root.contains(hit.node)) return null;
  const token = tokenOf(root, hit.node);
  if (token) {
    const box = token.getBoundingClientRect();
    return staticOffsetOfDomPoint(
      root,
      token,
      0,
      x > (box.left + box.right) / 2,
    );
  }
  return staticOffsetOfDomPoint(root, hit.node, hit.offset);
}

/** The DOM point of a clamped linear `offset` — the inverse of the reads above. */
function domPointAt(
  root: Node,
  offset: number,
): { node: Node; offset: number } {
  let acc = 0;
  let point: { node: Node; offset: number } | null = null;
  const walk = (n: Node): void => {
    if (point) return;
    const len = leafLength(n);
    if (len === null) {
      for (const child of Array.from(n.childNodes)) {
        walk(child);
        if (point) return;
      }
      return;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      if (offset <= acc + len) point = { node: n, offset: offset - acc };
    } else if (len > 0 && offset <= acc + len && n.parentNode) {
      // An atomic leaf: before it, or (at its far edge) after it.
      const index = Array.prototype.indexOf.call(
        n.parentNode.childNodes,
        n,
      ) as number;
      point = {
        node: n.parentNode,
        offset: offset === acc ? index : index + 1,
      };
    }
    acc += len;
  };
  for (const child of Array.from(root.childNodes)) {
    walk(child);
    if (point) break;
  }
  return point ?? { node: root, offset: root.childNodes.length };
}

/**
 * The DOM `Range` over linear `[from, to)`, both ends clamped into the text —
 * `linearDomRange`'s dual for a dormant line, for painting an editor-owned span
 * across it. Reads only.
 */
export function staticDomRange(root: Element, from: number, to: number): Range {
  const total = staticTextLength(root);
  const lo = Math.max(0, Math.min(from, to, total));
  const hi = Math.max(lo, Math.min(Math.max(from, to), total));
  const start = domPointAt(root, lo);
  const end = domPointAt(root, hi);
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}
