import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  PAGE_BLOCK_TYPE,
  type Block,
  type IdentifiedBlock,
  type RichText,
} from "../core";

/**
 * How a PARTIAL copy narrows the forest — an editor-owned text span, which
 * covers some lines whole and its two end lines in part.
 */
export interface SerializeForestOptions {
  /**
   * Runs to write in place of a block's `data.text`: the span's end lines
   * sliced, and every covered text line's LIVE runs (the row's `data.text` is a
   * projection that trails the doc by ~1s, so a copy right after typing would
   * otherwise carry the pre-keystroke text).
   */
  runsOverride?: ReadonlyMap<string, RichText>;
  /**
   * Descendants left out of the forest: the visible lines the span does NOT
   * cover that sit under a covered root (a parent's later children, after the
   * span's end). A row nobody excluded still travels with its root — a
   * collapsed child included, exactly as in a whole-block copy.
   */
  exclude?: ReadonlySet<string>;
}

/**
 * Build a portable `IdentifiedBlock[]` for `rootIds` and their descendants from
 * the in-memory document rows (all blocks, incl. collapsed children). Children
 * are ordered by rank.
 *
 * THE forest serializer — copy and duplicate both go through it, which is what
 * makes "duplicate ≡ copy + paste-after-each-source" true rather than merely
 * intended. It used to have a server-side twin (`serializeSubtree`) that the
 * bespoke duplicate endpoint ran; that endpoint and that twin are both gone.
 *
 * It stamps each node's SOURCE row id — the markdown walk reads it (a `<page
 * id="…"/>` tag has no other source of identity), and both consumers overwrite
 * it immediately: `withMintedIds` mints fresh ids for a duplicate, and a paste
 * re-mints for the clipboard forest too. The id here is provenance, never a
 * destination identity.
 *
 * A `type="page"` node's children are NOT here: its content lives in the page's
 * own partition, which these rows never hold. So a page node carries its
 * `pageSource` instead, and the server resolves the content when the forest
 * lands (a copy clones it; the first paste of a cut moves the page itself).
 */
export function serializeForest(
  rows: readonly Block[],
  rootIds: readonly string[],
  { runsOverride, exclude }: SerializeForestOptions = {},
): IdentifiedBlock[] {
  const childrenOf = new Map<string | null, Block[]>();
  for (const r of rows) {
    const list = childrenOf.get(r.parentId);
    if (list) list.push(r);
    else childrenOf.set(r.parentId, [r]);
  }
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  const build = (block: Block): IdentifiedBlock => {
    const children = (childrenOf.get(block.id) ?? [])
      .filter((c) => !exclude?.has(c.id))
      .sort((a, b) => Rank.compare(a.rank, b.rank))
      .map(build);
    return {
      id: block.id,
      type: block.type,
      data: runsOverride?.has(block.id)
        ? { ...(block.data as object), text: runsOverride.get(block.id) }
        : block.data,
      expanded: block.expanded,
      children,
      ...(block.type === PAGE_BLOCK_TYPE
        ? { pageSource: { pageId: block.id } }
        : {}),
    };
  };

  return rootIds
    .map((id) => byId.get(id))
    .filter((b): b is Block => b !== undefined)
    .map(build);
}
