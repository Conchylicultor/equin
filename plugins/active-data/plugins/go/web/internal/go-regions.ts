import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";
import { isBlockForm } from "@plugins/active-data/core";

/**
 * The `<go>` regions of a draft, read off the marker tokens. Markers are
 * recognised by their node type and token text rather than through the marker
 * module, so the marker's own ✕ can remove its region without an import cycle.
 */
export const GO_MARKER_TYPE = "go-marker";

export interface Region {
  open: string;
  close: string;
  /** Keys of everything between the markers. */
  inner: string[];
  /**
   * In block form (active-data's `isBlockForm` over the region's text, where a
   * paragraph boundary reads as a line break): drawn as a box.
   */
  block: boolean;
}

export interface Scan {
  regions: Region[];
  /** Markers with no partner (the user deleted the other edge). */
  orphans: string[];
}

/** `"<go>"` / `"</go>"` for a marker node, `null` for anything else. */
export function markerToken(node: LexicalNode): string | null {
  return node.getType() === GO_MARKER_TYPE ? node.getTextContent() : null;
}

export function $scan(): Scan {
  const out: Scan = { regions: [], orphans: [] };
  // The open region's text so far — what the sent message will hold between
  // the tags — so its shape is decided by the same rule as every other surface.
  let open: {
    open: string;
    inner: string[];
    body: string;
    para: number;
  } | null = null;
  $getRoot()
    .getChildren()
    .forEach((para, p) => {
      if (!$isElementNode(para)) return;
      if (open && open.para !== p) open.body += "\n";
      for (const child of para.getChildren()) {
        const token = markerToken(child);
        if (token === "<go>") {
          if (open) out.orphans.push(open.open);
          open = { open: child.getKey(), inner: [], body: "", para: p };
        } else if (token === "</go>") {
          if (!open) out.orphans.push(child.getKey());
          else
            out.regions.push({
              open: open.open,
              close: child.getKey(),
              inner: open.inner,
              block: isBlockForm(open.body),
            });
          open = null;
        } else if (open) {
          open.body += child.getTextContent();
          open.inner.push(child.getKey());
        }
      }
    });
  if (open) out.orphans.push((open as { open: string }).open);
  return out;
}

/**
 * Drop the whole region a close marker ends — both markers and every node
 * between — and any line it leaves empty (keeping one, so the draft is never
 * rootless).
 */
export function $removeGoRegion(closeKey: string): void {
  const region = $scan().regions.find((r) => r.close === closeKey);
  if (!region) return;
  const parents = new Set<ElementNode>();
  for (const key of [region.open, ...region.inner, region.close]) {
    const node = $getNodeByKey(key);
    if (!node) continue;
    const parent = node.getParent();
    if (parent) parents.add(parent);
    node.remove();
  }
  for (const parent of parents) {
    if (parent.getChildrenSize() === 0 && $getRoot().getChildrenSize() > 1)
      parent.remove();
  }
}

/**
 * A block region's open marker draws nothing, so the line it ends looks empty
 * and outside the box — yet a caret there sits INSIDE the region, after the
 * marker. Whatever lands on that line (typed, pasted, or joined up by a
 * Backspace) is moved in front of the marker: the line reads as the prose
 * above the card, as the wire grammar has it (the open tag ends its line).
 * Moving the nodes keeps their keys, so the caret follows the text.
 */
export function $liftOffOpenLine(node: LexicalNode): void {
  let marker: LexicalNode | null = null;
  for (let p = node.getPreviousSibling(); p; p = p.getPreviousSibling()) {
    if ($isLineBreakNode(p)) return;
    const token = markerToken(p);
    if (token === "</go>") return;
    if (token === "<go>") {
      marker = p;
      break;
    }
  }
  if (!marker) return;
  const key = marker.getKey();
  if (!$scan().regions.some((r) => r.open === key && r.block)) return;
  let next = marker.getNextSibling();
  while (next && !$isLineBreakNode(next) && markerToken(next) === null) {
    const after = next.getNextSibling();
    marker.insertBefore(next);
    next = after;
  }
}
