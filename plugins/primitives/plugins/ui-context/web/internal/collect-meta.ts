import {
  formatElementDescriptor,
  formatLineagePath,
  type UiContextMeta,
} from "../../core";
import { collectInnerSlots, collectLineage } from "./collect-lineage";
import { isBoxlessMarker, nearestOwner, nearestSource } from "./marker-walk";

const MAX_LABEL = 60;

function truncate(s: string, max = MAX_LABEL): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The element's own direct text, ignoring nested children. A button whose label
 * lives in a child span yields "" here, so we fall back to subtree text only as a
 * last resort — this keeps container clicks from capturing a whole subtree's text. */
function ownText(el: Element): string {
  let s = "";
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) s += n.textContent ?? "";
  }
  return s.trim();
}

/** The element's descriptor: tag (+ role, + an input/button `type`) + the best
 * available accessible text. Spelled by the shared core formatter, so the chip
 * can parse it back into a human label. */
function describeElement(el: Element): string {
  const name =
    el.getAttribute("aria-label") ||
    (el as HTMLElement).title ||
    el.getAttribute("placeholder") ||
    ownText(el) ||
    el.textContent ||
    "";
  return formatElementDescriptor({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    type:
      el.tagName === "INPUT" ? el.getAttribute("type") || undefined : undefined,
    name: truncate(name) || undefined,
  });
}

/** One selector segment: prefer a stable, unique anchor (id, then test id) and
 * otherwise fall back to the bare tag name. */
function segmentFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${CSS.escape(el.id)}`;
  const testid = el.getAttribute("data-testid");
  if (testid) return `${tag}[data-testid="${testid}"]`;
  return tag;
}

/** A CSS path (up to 6 real segments) from the element up its ancestors, anchored
 * with ids / test ids where available so the agent can actually locate the node. */
function preciseSelector(el: Element): string {
  const segments: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && segments.length < 6) {
    if (!isBoxlessMarker(cur)) segments.unshift(segmentFor(cur));
    cur = cur.parentElement;
  }
  return segments.join(">");
}

export function collectMeta(el: Element): UiContextMeta {
  const nodes = collectLineage(el);
  // `plugin` / `slot` / `contribution` always describe ONE node — the innermost,
  // of whatever kind — never a `plugin=` from one node paired with a `slot=`
  // inherited from another. A pick inside a pane's own markup therefore reports
  // the pane's owning plugin and no slot, instead of climbing past the region to
  // the app shell's Apps.App contribution. The full truth is always in `path`.
  const innermost = nodes[nodes.length - 1];
  const contribution =
    innermost?.kind === "contribution" ? innermost : undefined;
  return {
    url: window.location.href,
    pluginId: innermost?.pluginId,
    slotId: contribution?.slotId,
    contributionId: contribution?.contributionId,
    // Unconditional: `path` is the sole carrier of region information (which
    // pane / tab / window the element sits in), so gating it on "adds more than
    // the innermost node" would drop that whenever the chain is one node long.
    path: formatLineagePath(nodes) || undefined,
    innerSlots: collectInnerSlots(el).join(", ") || undefined,
    element: describeElement(el),
    selector: preciseSelector(el),
    source: nearestSource(el),
    owner: nearestOwner(el),
  };
}
