import {
  isBoxlessMarker,
  nearestOwner,
  nearestSource,
} from "@plugins/primitives/plugins/ui-context/web";

import { RENDER_LOOP } from "../../core";
import { capSignature } from "./cap-signature";

/**
 * The stable build/composition markers that survive a React teardown→rebuild
 * because they're keyed by plugin/slot/source identity, not React instance.
 *
 * Reading the lineage grammar is `primitives/ui-context`'s job, so the three
 * walks it owns (`isBoxlessMarker`, `nearestSource`, `nearestOwner`) are imported
 * from its web barrel — it is the neutral leaf built for exactly this consumer.
 * The local copies that used to live here had drifted: their marker test keyed
 * on `data-slot-id`, which does not recognize `<UiRegion>`, so every culprit
 * inside a miller column or a full-pane resolved to `ui-region.tsx`.
 *
 * What stays local below is genuinely this detector's own: a churn-robust
 * bounded path, the signature `Map` key, the aggregate rollup root, and the
 * `data-pane-id` read (a separate DOM convention `ui-context` does not own).
 */
export interface CulpritMeta {
  /** `pluginId@slotId | data-source | data-ui-owner | pane:<id> | boundedPath`. */
  signature: string;
  pluginId?: string;
  slotId?: string;
  contributionId?: string;
  source?: string;
  owner?: string;
  paneId?: string;
  selector?: string;
  /**
   * The coarse, stable container the aggregate (subtree-cascade) tier rolls this
   * node up to: `pane:<paneId>` when inside a pane (the natural cascade boundary),
   * else the nearest plugin marker's `pluginId@slotId`, else undefined (not
   * tracked aggregately — never roll up to bare document-body). All per-node
   * variance (path, source, owner) is dropped so a whole subtree shares one key.
   */
  aggregateRoot?: string;
}

/** The nearest `[data-plugin-id]` marker span above the element (skipping ""). */
function nearestMarker(el: Element): {
  pluginId?: string;
  slotId?: string;
  contributionId?: string;
} {
  let cur: Element | null = el;
  while (cur) {
    const m: HTMLElement | null = cur.closest<HTMLElement>("[data-plugin-id]");
    if (!m) break;
    const pluginId = m.dataset.pluginId;
    if (pluginId) {
      return {
        pluginId,
        slotId: m.dataset.slotId || undefined,
        contributionId: m.dataset.contributionId || undefined,
      };
    }
    cur = m.parentElement;
  }
  return {};
}

/** This element's `nth-of-type` index among same-tag siblings (1-based). */
function nthOfType(el: Element): number {
  const tag = el.tagName;
  let n = 1;
  let sib: Element | null = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === tag) n += 1;
    sib = sib.previousElementSibling;
  }
  return n;
}

/**
 * A bounded `tagName:nth-of-type(k)` path from the node up to the nearest
 * stable-marker anchor (a `[data-plugin-id]` / `[data-source]` / pane host),
 * capped at PATH_MAX_DEPTH so two code blocks sharing one source line still
 * separate. Uses `nth-of-type` (NOT `nth-child`) so the index is robust to
 * sibling text/comment nodes that come and go during a rebuild.
 */
function boundedPath(el: Element): string {
  const segments: string[] = [];
  let cur: Element | null = el;
  while (cur && segments.length < RENDER_LOOP.PATH_MAX_DEPTH) {
    if (!isBoxlessMarker(cur)) {
      const tag = cur.tagName.toLowerCase();
      segments.unshift(`${tag}:nth-of-type(${nthOfType(cur)})`);
    }
    // Stop once we reach a stable anchor: its identity is already in the prefix.
    if (
      cur.parentElement &&
      (cur.parentElement.hasAttribute("data-plugin-id") ||
        cur.parentElement.hasAttribute("data-source") ||
        cur.parentElement.hasAttribute("data-pane-id"))
    ) {
      break;
    }
    cur = cur.parentElement;
  }
  return segments.join(">");
}

/**
 * Resolve a mutation target (which may be a text node) to its parent element,
 * then compose the stable culprit signature.
 */
export function culpritMeta(node: Node): CulpritMeta {
  const el: Element | null =
    node instanceof Element ? node : node.parentElement;
  if (!el) {
    return { signature: "<detached>" };
  }

  const marker = nearestMarker(el);
  const source = nearestSource(el);
  const owner = nearestOwner(el);
  const paneId =
    el.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId || undefined;
  const path = boundedPath(el);

  const pluginPart = marker.pluginId
    ? marker.slotId
      ? `${marker.pluginId}@${marker.slotId}`
      : marker.pluginId
    : "?";
  const parts = [
    pluginPart,
    source ?? "",
    owner ?? "",
    paneId ? `pane:${paneId}` : "",
    path,
  ];
  const signature = capSignature(parts.join(" | "), RENDER_LOOP.SIGNATURE_CAP);

  // The aggregate root drops all per-node variance, keeping only the coarse
  // container identity so a whole subtree shares one rollup key. Prefer the pane
  // (the natural cascade boundary), else the plugin marker, else untracked.
  const aggregateRoot = paneId
    ? `pane:${paneId}`
    : marker.pluginId
      ? pluginPart
      : undefined;

  return {
    signature,
    pluginId: marker.pluginId,
    slotId: marker.slotId,
    contributionId: marker.contributionId,
    source,
    owner,
    paneId,
    selector: path || undefined,
    aggregateRoot,
  };
}
