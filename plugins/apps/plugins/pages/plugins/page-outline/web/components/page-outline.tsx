import { useCallback, useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  inDocumentOrder,
  pageBlocks,
  plainOf,
  toNodes,
  type Block,
  type BlockHandle,
} from "@plugins/page/plugins/editor/core";
import {
  blockContentScope,
  blockRowIn,
  Editor,
} from "@plugins/page/plugins/editor/web";
import { OutlineRail } from "@plugins/primitives/plugins/outline/plugins/rail/web";

/** A block type that declares itself a heading, plus the handle that reads its text. */
interface HeadingType {
  level: number;
  handle: BlockHandle<unknown>;
}

/**
 * Block type → its heading level, read off each type's OWN declared
 * `handle.semantics` (`{ role: "heading", level }`).
 *
 * This plugin therefore names no block type. A `heading-4` plugin registered
 * tomorrow appears in the outline with zero edits here — and, just as important,
 * a big-but-not-heading block type never does, because "renders large"
 * (`textVariant`) and "is a heading" (`semantics`) are separate declarations in
 * the editor's block API and only one of them is a claim about structure.
 */
function useHeadingTypes(): ReadonlyMap<string, HeadingType> {
  const contributions = Editor.Block.useContributions();
  return useMemo(() => {
    const out = new Map<string, HeadingType>();
    for (const c of contributions) {
      const semantics = c.block.semantics;
      // A non-string `match` (RegExp / predicate) claims no single type id, so
      // there is no key to file it under — same rule `useIsFramedBlock` uses.
      if (typeof c.match !== "string" || semantics?.role !== "heading")
        continue;
      out.set(c.match, { level: semantics.level, handle: c.block });
    }
    return out;
  }, [contributions]);
}

/**
 * The open page's headings, as the outline rail pinned to the right edge of the
 * pane. Mounted through `PageDetail.Overlay`.
 */
export function PageOutline({ pageId }: { pageId: string }) {
  const headingTypes = useHeadingTypes();
  // THIS pane's editor, never `document`. The rail renders beside the pane's
  // scroller — outside the editor's subtree — so it cannot ref the block grid or
  // walk up to it, and a document-wide `[data-block-id]` lookup answers with
  // whichever editor is first in the DOM. Two panes on the same page, or the
  // same page open in two tabs (every open tab stays mounted), then resolve
  // every heading to the OTHER editor's rows — and a background tab's rows are
  // `display:none`, so their rects are all zero and the rail simply dies.
  const content = blockContentScope.useRoot();
  const result = useLive(pageBlocks, { where: { pageId } });
  // The last value keeps painting through a transient error; a page never
  // loaded has no outline yet — `null`, not an empty one. A first load that
  // failed paints no rail either: the rail is an overlay, and the page's own
  // editor renders the failure.
  const blocks = foldResource(result, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (data) => data,
  });

  const entries = useMemo(() => {
    if (blocks === undefined) return null;
    const headings = new Map<string, Block>();
    for (const b of blocks) if (headingTypes.has(b.type)) headings.set(b.id, b);
    // `inDocumentOrder`, NOT `flattenVisible`: the outline is a map of the
    // DOCUMENT, so a heading nested inside a collapsed toggle still belongs in
    // it. (It resolves to no element until the toggle is opened — see
    // `resolve` below.)
    const out: { id: string; label: string; depth: number }[] = [];
    for (const id of inDocumentOrder(toNodes(blocks), [...headings.keys()])) {
      const block = headings.get(id)!;
      const heading = headingTypes.get(block.type)!;
      // The handle's own text lens, never `data.text` read by hand — the lens is
      // typed against the block's own payload, so a field rename is a compile
      // error in the block's plugin instead of a silently blank outline row.
      const label = plainOf(heading.handle.text?.(block.data)).trim();
      // An empty heading names nothing, so it is not an entry.
      if (label === "") continue;
      out.push({ id, label, depth: Math.max(0, heading.level - 1) });
    }
    return out;
  }, [blocks, headingTypes]);

  const resolve = useCallback(
    // Before the editor's grid attaches there is no row for ANY heading — one
    // commit, and the rail re-enrols when the elements appear. A `null` from
    // `blockRowIn` means something else entirely: that heading is in the
    // document but has no row, because a collapsed toggle holds it.
    (id: string) => (content.attached ? blockRowIn(content.root, id) : null),
    [content],
  );

  // Not known yet renders nothing — the rail is an overlay, and a rail of no
  // dashes would claim the page has no headings.
  if (entries === null) return null;
  return (
    <OutlineRail entries={entries} resolve={resolve} label="Page outline" />
  );
}
