import {
  formatElementDescriptor,
  formatLineagePath,
  lineageNodeIdentity,
  parseElementDescriptor,
  parseLineagePath,
  type LineageNode,
} from "../../core";
import { collectLineage } from "./collect-lineage";
import { describeElement } from "./collect-meta";
import { LINEAGE_ATTR, NODE_ATTR } from "./lineage-attrs";
import { INTERACTIVE_SELECTOR, isShown } from "./shown";

/** An element named the way a `<ui-context>` token (or an outline entry) names it. */
export interface UiContextRef {
  /** Its lineage path (`formatLineagePath`); `""` outside every lineage node. */
  readonly path: string;
  /** Its element descriptor (`formatElementDescriptor`). */
  readonly element: string;
}

/**
 * Where a named element is on the page now: `found` (exactly one shown match),
 * `ambiguous` (several — `el` is the first in document order, `count` how many),
 * or `gone` (nothing shown matches: another page, a closed popover, a stale or
 * mistyped name) — with what the page holds instead, for a caller to log.
 */
export type UiContextResolution =
  | { readonly kind: "found"; readonly el: HTMLElement }
  | {
      readonly kind: "ambiguous";
      readonly el: HTMLElement;
      readonly count: number;
    }
  | { readonly kind: "gone"; readonly near: UiContextNear };

/**
 * What a `gone` resolve saw instead: evidence of WHY nothing matched, so a
 * failure can be read afterwards rather than reproduced. Each list is capped
 * at {@link NEAR_LIMIT}.
 */
export interface UiContextNear {
  /** `element` is not a descriptor at all — nothing could match. */
  readonly notADescriptor: boolean;
  /** Elements with the same descriptor anywhere on the page: their lineage
   *  path, and whether they are shown (a stale path, or a hidden copy). */
  readonly sameElement: readonly { path: string; shown: boolean }[];
  /** Shown controls under the path's innermost node: their descriptors (a
   *  renamed control). */
  readonly underPath: readonly string[];
}

const NEAR_LIMIT = 10;

/** A CSS attribute selector `[name="value"]`: inside a quoted string only `"`
 *  and `\\` need escaping. */
const attrIs = (name: string, value: string) =>
  `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;

/** The markers stamped for `node` (see `lineage-attrs.ts`'s grammar). */
function markerSelector(node: LineageNode): string {
  if (node.kind === "contribution")
    return (
      attrIs(NODE_ATTR, "contribution") +
      attrIs("data-plugin-id", node.pluginId) +
      (node.slotId ? attrIs("data-slot-id", node.slotId) : "")
    );
  return (
    attrIs(NODE_ATTR, "region") +
    attrIs("data-region-kind", node.regionKind) +
    attrIs("data-region-id", node.id)
  );
}

/**
 * The elements a descriptor's markup head can be: the tag, its role (or none),
 * its input type. The name is compared afterwards, on the few that remain.
 */
function headSelector(element: string): string | null {
  const d = parseElementDescriptor(element);
  if (!d) return null;
  // The tag is `[a-z][a-z0-9-]*` (the descriptor grammar): a valid type selector as is.
  return (
    d.tag +
    (d.role ? attrIs("role", d.role) : ":not([role])") +
    (d.tag === "input"
      ? d.type
        ? attrIs("type", d.type)
        : ":not([type])"
      : "")
  );
}

/**
 * The inverse of `collectMeta` (and of an outline entry): the shown element
 * whose lineage path and descriptor are `ref`'s, compared in their canonical
 * spellings (parsed and re-formatted, so spacing does not matter).
 *
 * The path may be partial: an element whose lineage holds the path's segments
 * in order (a subsequence — an agent copying an outline entry often keeps
 * only the line it read the control under, not every group line above it)
 * matches too, but only when no element's lineage IS the path. A precise
 * name never loses to a looser reading of itself; a partial one still finds
 * its control, and several are `ambiguous` as usual.
 *
 * Nodes are compared by identity (`lineageNodeIdentity`): a region's label —
 * "column 2 of 2" — is its position among siblings, which changes when a
 * column opens or closes, so it never decides a match.
 *
 * The search is scoped to the markers of the path's innermost node (plus every
 * portaled lineage host, whose content sits outside the markers) and to the
 * descriptor's tag / role / type, so only a handful of elements are described
 * and walked. A `path` of `""` searches the whole document and is always
 * exact (outside every lineage node) — read partially, it would name every
 * element. An `element` that is not a descriptor matches nothing (`gone`).
 */
export function resolveUiContext(ref: UiContextRef): UiContextResolution {
  const nodes = parseLineagePath(ref.path);
  const wanted = nodes.map(lineageNodeIdentity);
  const descriptor = parseElementDescriptor(ref.element);
  const head = headSelector(ref.element);
  if (!descriptor || head === null)
    return {
      kind: "gone",
      near: { notADescriptor: true, sameElement: [], underPath: [] },
    };
  const element = formatElementDescriptor(descriptor);

  const roots = searchRoots(nodes);
  const candidates = new Set<HTMLElement>();
  for (const root of roots) {
    if (root instanceof HTMLElement && root.matches(head)) candidates.add(root);
    for (const el of root.querySelectorAll<HTMLElement>(head))
      candidates.add(el);
  }
  const named = [...candidates]
    .filter((el) => describeElement(el) === element && isShown(el))
    .map((el) => ({
      el,
      lineage: collectLineage(el).map(lineageNodeIdentity),
    }));
  const exact = named.filter((c) => sameSequence(c.lineage, wanted));
  const matches = (
    exact.length > 0 || wanted.length === 0
      ? exact
      : named.filter((c) => isSubsequence(wanted, c.lineage))
  )
    .map((c) => c.el)
    .sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
  const first = matches[0];
  if (!first) return { kind: "gone", near: nearMisses(head, element, roots) };
  return matches.length === 1
    ? { kind: "found", el: first }
    : { kind: "ambiguous", el: first, count: matches.length };
}

/** Where a path's element can be: under the markers of its innermost node,
 *  plus every portaled lineage host (whose content sits outside them). */
function searchRoots(nodes: readonly LineageNode[]): Element[] {
  const innermost = nodes.at(-1);
  return innermost
    ? [
        ...document.querySelectorAll(markerSelector(innermost)),
        ...document.querySelectorAll(`[${LINEAGE_ATTR}]`),
      ]
    : [document.body];
}

/** The evidence a `gone` carries: the same descriptor anywhere on the page,
 *  and the shown controls where the path points. Only run on a miss. */
function nearMisses(
  head: string,
  element: string,
  roots: readonly Element[],
): UiContextNear {
  const sameElement = [...document.querySelectorAll(head)]
    .filter((el) => describeElement(el) === element)
    .slice(0, NEAR_LIMIT)
    .map((el) => ({
      path: formatLineagePath(collectLineage(el)),
      shown: isShown(el),
    }));
  const underPath = new Set<string>();
  for (const root of roots)
    for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (underPath.size >= NEAR_LIMIT) break;
      if (isShown(el)) underPath.add(describeElement(el));
    }
  return { notADescriptor: false, sameElement, underPath: [...underPath] };
}

function sameSequence(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Whether `part` appears in `whole` in order (not necessarily adjacent). */
function isSubsequence(part: readonly string[], whole: readonly string[]) {
  let i = 0;
  for (const seg of whole) if (i < part.length && seg === part[i]) i++;
  return i === part.length;
}
