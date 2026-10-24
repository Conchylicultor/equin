import {
  formatElementDescriptor,
  formatLineagePath,
  parseElementDescriptor,
  parseLineagePath,
  type LineageNode,
} from "../../core";
import { collectLineage } from "./collect-lineage";
import { describeElement } from "./collect-meta";
import { LINEAGE_ATTR, NODE_ATTR } from "./lineage-attrs";
import { isShown } from "./shown";

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
 * mistyped name).
 */
export type UiContextResolution =
  | { readonly kind: "found"; readonly el: HTMLElement }
  | {
      readonly kind: "ambiguous";
      readonly el: HTMLElement;
      readonly count: number;
    }
  | { readonly kind: "gone" };

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
 * The search is scoped to the markers of the path's innermost node (plus every
 * portaled lineage host, whose content sits outside the markers) and to the
 * descriptor's tag / role / type, so only a handful of elements are described
 * and walked. A `path` of `""` searches the whole document. An `element` that
 * is not a descriptor matches nothing (`gone`).
 */
export function resolveUiContext(ref: UiContextRef): UiContextResolution {
  const nodes = parseLineagePath(ref.path);
  const path = formatLineagePath(nodes);
  const descriptor = parseElementDescriptor(ref.element);
  const head = headSelector(ref.element);
  if (!descriptor || head === null) return { kind: "gone" };
  const element = formatElementDescriptor(descriptor);

  const innermost = nodes.at(-1);
  const roots: Element[] = innermost
    ? [
        ...document.querySelectorAll(markerSelector(innermost)),
        ...document.querySelectorAll(`[${LINEAGE_ATTR}]`),
      ]
    : [document.body];

  const candidates = new Set<HTMLElement>();
  for (const root of roots) {
    if (root instanceof HTMLElement && root.matches(head)) candidates.add(root);
    for (const el of root.querySelectorAll<HTMLElement>(head))
      candidates.add(el);
  }
  const matches = [...candidates]
    .filter(
      (el) =>
        el instanceof HTMLElement &&
        describeElement(el) === element &&
        formatLineagePath(collectLineage(el)) === path &&
        isShown(el),
    )
    .sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
  const first = matches[0];
  if (!first) return { kind: "gone" };
  return matches.length === 1
    ? { kind: "found", el: first }
    : { kind: "ambiguous", el: first, count: matches.length };
}
