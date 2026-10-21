import type { LineageNode } from "../../core";
import {
  LINEAGE_ATTR,
  NODE_ATTR,
  parseLineage,
  readLineageNode,
} from "./lineage-attrs";

/**
 * Walk every nested lineage marker between the given element and the document,
 * outer→inner. Unlike a single `closest()`, this preserves the full composition
 * chain — who contributes into whose slot, inside which region — so a consumer
 * sees the composition path, not just the innermost plugin.
 */
export function collectLineage(el: Element): LineageNode[] {
  const nodes: LineageNode[] = [];
  let cur: Element | null = el;
  while (cur) {
    const marker: HTMLElement | null = cur.closest<HTMLElement>(
      `[${NODE_ATTR}]`,
    );
    if (!marker) break;
    // Null means the marker carries no usable identity (a contribution with an
    // empty `data-plugin-id`); skip it so the chain only carries real entries.
    const node = readLineageNode(marker);
    if (node) nodes.unshift(node);
    cur = marker.parentElement;
  }
  // Cross a portal boundary: a portaled positioner carries the originating tree's
  // full outer→inner lineage (the `display:contents` marker spans stayed behind in
  // the source tree, unreachable via DOM ancestry). Splice it ahead of any nodes
  // collected inside the portal. Non-portaled content has no lineage host, so this
  // is a no-op and the marker-span walk above stands alone.
  const lineageHost = el.closest<HTMLElement>(`[${LINEAGE_ATTR}]`);
  if (lineageHost) {
    nodes.unshift(...parseLineage(lineageHost.getAttribute(LINEAGE_ATTR) ?? undefined));
  }
  return nodes;
}

/** The most slots {@link collectInnerSlots} names — a pick on a whole pane
 *  holds dozens, and past a handful the list stops placing anything. */
const MAX_INNER_SLOTS = 8;

/**
 * The slots whose contributions sit inside `el` — the downward twin of
 * {@link collectLineage}. Only the outermost layer counts (a contribution
 * nested in another contribution inside `el` belongs to that one's slot, not to
 * `el`), distinct, in document order.
 *
 * It is what places a pick on a container: a bar or wrapper that lays slots out
 * but lies in none of them has a lineage ending at its pane and a label of
 * `div`, so without this nothing in the token says WHICH part of the pane it is.
 */
export function collectInnerSlots(el: Element): string[] {
  const slots: string[] = [];
  const contributionSelector = `[${NODE_ATTR}="contribution"]`;
  for (const marker of el.querySelectorAll<HTMLElement>(contributionSelector)) {
    const enclosing = marker.parentElement?.closest(contributionSelector);
    if (enclosing && enclosing !== el && el.contains(enclosing)) continue;
    const slotId = marker.dataset.slotId;
    if (!slotId || slots.includes(slotId)) continue;
    slots.push(slotId);
    if (slots.length === MAX_INNER_SLOTS) break;
  }
  return slots;
}
