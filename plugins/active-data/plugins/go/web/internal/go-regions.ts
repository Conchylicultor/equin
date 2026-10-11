import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";

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
  /** Spans lines (paragraphs, or line breaks inside one): drawn as a box. */
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
  let open: (Omit<Region, "close"> & { para: number }) | null = null;
  $getRoot()
    .getChildren()
    .forEach((para, p) => {
      if (!$isElementNode(para)) return;
      if (open && open.para !== p) open.block = true;
      for (const child of para.getChildren()) {
        const token = markerToken(child);
        if (token === "<go>") {
          if (open) out.orphans.push(open.open);
          open = { open: child.getKey(), inner: [], block: false, para: p };
        } else if (token === "</go>") {
          if (!open) out.orphans.push(child.getKey());
          else
            out.regions.push({
              open: open.open,
              close: child.getKey(),
              inner: open.inner,
              block: open.block,
            });
          open = null;
        } else if (open) {
          if ($isLineBreakNode(child)) open.block = true;
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
