/**
 * The UI-context lineage node model.
 *
 * A **lineage** is the outer→inner chain of things that composed a given DOM
 * element: which plugin contributed into whose slot, and which named region of
 * the screen the whole thing sits in. There are exactly two kinds of node, and
 * they are a discriminated union rather than one flat all-optional shape — a
 * formatter that had to guess the kind from field presence would reintroduce
 * the very ambiguity this model exists to remove, and consumers need an honest
 * `n.kind === "region"` predicate.
 */

/** One slot contribution in the composition chain. Produced by the picker's
 *  opt-in slot-item middleware, which wraps every contribution in a
 *  `display:contents` marker span. */
export interface ContributionNode {
  kind: "contribution";
  pluginId: string;
  slotId?: string;
  /** Author-supplied id, keyed cross-plugin as `pluginId:id`. */
  contributionId?: string;
}

/** One named region of the screen — a miller column, a tab, a window. Produced
 *  explicitly by whoever renders the region: position among SIBLING regions is
 *  not inferable from an upward DOM walk (an upward walk from column 3 crosses
 *  only column 3's marker), so the producer must supply it. */
export interface RegionNode {
  kind: "region";
  /** Open set of surface kinds: "pane" | "tab" | "window" | … */
  regionKind: string;
  /** Identity within that kind (pane id, tab id, window id). */
  id: string;
  /** Human position or name within the producer's set — "column 3 of 3".
   *  Free-form: only the producer knows what "where" means for its kind, and
   *  the value is model-facing prose, not machine input. */
  label?: string;
  /** The plugin owning the region's CONTENT (not the one rendering the frame). */
  pluginId?: string;
}

export type LineageNode = ContributionNode | RegionNode;

/**
 * One node, rendered. `@` means "contributes into"; `#` means "occupies".
 *
 * Lives beside the model on purpose: a second consumer must not be able to
 * re-derive its own spelling of the same chain.
 */
export function formatLineageNode(n: LineageNode): string {
  if (n.kind === "contribution") {
    return n.slotId ? `${n.pluginId}@${n.slotId}` : n.pluginId;
  }
  const label = n.label ? `[${n.label}]` : "";
  return `${n.pluginId ?? ""}#${n.regionKind}:${n.id}${label}`;
}

/**
 * What makes two nodes the same node: the formatted node without a region's
 * `label`. The label is the producer's prose about where the region sits
 * among its siblings ("column 2 of 2"), which changes as siblings come and go
 * while the region stays the one it was — so a reader matching a written path
 * against the page compares identities, never the labels.
 */
export function lineageNodeIdentity(n: LineageNode): string {
  return formatLineageNode(
    n.kind === "region" ? { ...n, label: undefined } : n,
  );
}

/** The separator between nodes — written by the formatter, read by the parser,
 *  spelled once so the two cannot drift. */
const PATH_SEP = " > ";

/** Outer→inner chain. */
export function formatLineagePath(nodes: LineageNode[]): string {
  return nodes.map(formatLineageNode).join(PATH_SEP);
}

/** `pluginId?#regionKind:id[label]?` — the region spelling of
 *  `formatLineageNode`, read back. The id is lazy so the optional `[label]`
 *  suffix wins the tail when present. */
const REGION_RE = /^([^#]*)#([^:]+):(.+?)(?:\[(.*)\])?$/;

/**
 * One formatted segment, read back into a node — the exact inverse of
 * `formatLineageNode`, and here beside it for the same reason the formatter is
 * beside the model: a display that re-derived its own spelling of the grammar
 * would drift from the one that wrote it.
 *
 * TOTAL, with no failure arm: `pluginId` alone is a legal contribution segment,
 * so any string that matches neither the region nor the `@` shape simply *is*
 * that plugin id. There is nothing to absorb — a malformed segment round-trips
 * back to itself and displays verbatim.
 */
export function parseLineageNode(segment: string): LineageNode {
  const region = REGION_RE.exec(segment);
  if (region) {
    const [, pluginId, regionKind, id, label] = region;
    return {
      kind: "region",
      regionKind: regionKind!,
      id: id!,
      ...(label ? { label } : {}),
      ...(pluginId ? { pluginId } : {}),
    };
  }
  const at = segment.indexOf("@");
  return at === -1
    ? { kind: "contribution", pluginId: segment }
    : {
        kind: "contribution",
        pluginId: segment.slice(0, at),
        slotId: segment.slice(at + 1),
      };
}

/** Outer→inner chain, read back. Inverse of `formatLineagePath`. */
export function parseLineagePath(path: string): LineageNode[] {
  return path
    .split(PATH_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseLineageNode);
}
