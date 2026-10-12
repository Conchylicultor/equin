// Pure composition helpers for the composite block store (inline nested-page
// expansion). The composite fans N per-page `useServerBlockStore` feeds into one
// union document; these helpers own the three pure concerns:
//
//   - `deriveMounts`      — which pages subscribe (BFS over the feeds from the
//                           base page, expansion-driven, guarded).
//   - `remapUnionParents` — union-space parent rewriting so page-link content
//                           nests under its link row (sub-pages need none).
//   - owner resolution + `translateOpForStore` — route every write to the page
//                           that owns its rows, translating union-space anchor
//                           ids back to real parents first.
//
// Pure module (no React): unit-tested directly in `composition.test.ts`.

import { PAGE_BLOCK_TYPE, type BlockOp, type BlockPatch } from "../../core";
import {
  narrowDeleteOverlayOp,
  type BlockOverlayOp,
} from "./optimistic-block-ops";

/**
 * The pages a composite editor subscribes to: `mountedPageId → anchorBlockId`,
 * in mount (BFS) order — the union concatenation order. Two mount shapes share
 * the map:
 *
 *  - **Identity mount** (sub-page): `anchor === pageId`. The page's shell row
 *    (`type="page"`, id = the pageId) is already present in its container's
 *    feed, and the child's top-level rows carry `parentId = shellId` — so the
 *    union nests with no rewriting.
 *  - **Translated mount** (page-link): `anchor` is the link block's own id. The
 *    linked page's shell lives elsewhere (not in the union), so its top-level
 *    rows (`parentId = pageId`) are rewritten to nest under the link row.
 */
export type Mounts = ReadonlyMap<string, string>;

/** The row fields `deriveMounts` reads off a feed. `Block` satisfies this
 *  (`data` is optional because `z.unknown()` infers an optional field). */
export interface MountSourceRow {
  id: string;
  type: string;
  expanded: boolean;
  data?: unknown;
}

/** The row fields owner resolution reads off the union. `Block` satisfies this. */
export interface UnionRow {
  id: string;
  pageId: string | null;
  type: string;
}

// The page-link block type tag. A literal, not an import: `page-link` imports
// the editor (`defineBlock`), so the editor cannot import it back without a
// cross-plugin cycle. The composite only needs the tag + `data.pageId` to know
// where an expanded link points.
const PAGE_LINK_BLOCK_TYPE = "page-link";

/** A page-link row's target pageId, or null when unset/unresolved (`""`). */
function linkTargetPageId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const pageId = (data as Record<string, unknown>).pageId;
  return typeof pageId === "string" && pageId !== "" ? pageId : null;
}

/**
 * Which pages the composite subscribes to, walked breadth-first from the base
 * page's feed: every expanded `type="page"` row is an identity mount; every
 * expanded page-link row with a resolved target is a translated mount. A page
 * whose feed has not published yet contributes no further expansions (they
 * mount on its first push — a push-driven fixpoint at expansion depth).
 * Collapsed pages are never in the result, so they are never subscribed — the
 * perf bound.
 *
 * One membership check carries both Stage-2 guards: a page already in `mounts`
 * never mounts again. That is the **once-per-surface** rule directly, and it
 * subsumes the **cycle** guard — every page in a row's expansion ancestry
 * (including the base itself) was inserted into `mounts` before that row's
 * feed was walked, so a link back up the chain is always "already mounted".
 */
export function deriveMounts(
  basePageId: string,
  feeds: ReadonlyMap<string, readonly MountSourceRow[]>,
): Map<string, string> {
  const mounts = new Map<string, string>([[basePageId, basePageId]]);
  const queue = [basePageId];
  while (queue.length > 0) {
    const pageId = queue.shift()!;
    const rows = feeds.get(pageId);
    if (!rows) continue;
    for (const row of rows) {
      if (!row.expanded) continue;
      let target: string | null = null;
      if (row.type === PAGE_BLOCK_TYPE) target = row.id;
      else if (row.type === PAGE_LINK_BLOCK_TYPE)
        target = linkTargetPageId(row.data);
      if (target === null || mounts.has(target)) continue;
      mounts.set(target, row.id);
      queue.push(target);
    }
  }
  return mounts;
}

/**
 * `mountedPageId` keyed by its anchor, for the TRANSLATED (page-link) mounts
 * only — `anchor ≠ pageId`. The anchor row stands in for the mounted page's
 * shell in union space, so this map is what turns a union-space parent back
 * into the real one.
 */
export function pageByAnchor(mounts: Mounts): Map<string, string> {
  const byAnchor = new Map<string, string>();
  for (const [pageId, anchorId] of mounts) {
    if (anchorId !== pageId) byAnchor.set(anchorId, pageId);
  }
  return byAnchor;
}

/**
 * Rewrite union rows into render (union) space: a translated mount's top-level
 * rows (`parentId === mountedPageId`, the shell that is NOT in the union) nest
 * under the anchor (link) row instead. Identity — the SAME array reference —
 * when every mount is a sub-page, so a link-free union churns nothing.
 */
export function remapUnionParents<T extends { parentId: string | null }>(
  rows: T[],
  mounts: Mounts,
): T[] {
  const byAnchor = pageByAnchor(mounts);
  if (byAnchor.size === 0) return rows;
  const anchorByPage = new Map<string, string>();
  for (const [anchorId, pageId] of byAnchor) anchorByPage.set(pageId, anchorId);
  let changed = false;
  const next: T[] = [];
  for (const row of rows) {
    const anchorId =
      row.parentId === null ? undefined : anchorByPage.get(row.parentId);
    if (anchorId === undefined) {
      next.push(row);
    } else {
      changed = true;
      next.push({ ...row, parentId: anchorId });
    }
  }
  return changed ? next : rows;
}

/**
 * Union-space parent id → real store-space parent id: a translated mount's
 * anchor stands in for the mounted page row, so writes naming it as a parent
 * target the real page id. Identity for everything else (incl. sub-page
 * shells, where anchor === pageId already).
 */
export function translateUnionParentId(
  parentId: string | null,
  mounts: Mounts,
): string | null {
  if (parentId === null) return null;
  return pageByAnchor(mounts).get(parentId) ?? parentId;
}

/**
 * The page owning `id`'s row in the union. Throws on an unknown id or a row
 * with no owning page — never a silent drop (an unroutable write is a bug, not
 * a no-op).
 */
export function rowOwnerPage(rows: readonly UnionRow[], id: string): string {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`Block ${id} is not in the composed document`);
  if (row.pageId === null) throw new Error(`Block ${id} has no owning page`);
  return row.pageId;
}

/** Group `ids` by their owning page (union lookup; throws on unknown ids). */
export function groupIdsByOwnerPage(
  rows: readonly UnionRow[],
  ids: readonly string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const owner = rowOwnerPage(rows, id);
    const group = groups.get(owner);
    if (group) group.push(id);
    else groups.set(owner, [id]);
  }
  return groups;
}

/**
 * The single page owning every one of `ids`; throws when they span pages (the
 * v1 mixed-page bulk guard — fail loudly rather than half-apply) or when any id
 * is unknown.
 */
export function singleOwnerPage(
  rows: readonly UnionRow[],
  ids: readonly string[],
): string {
  const groups = groupIdsByOwnerPage(rows, ids);
  if (groups.size !== 1) {
    throw new Error(
      `Bulk operation spans ${groups.size} pages (${[...groups.keys()].join(", ")}); ` +
        `cross-page bulk ops are not supported`,
    );
  }
  return groups.keys().next().value!;
}

/**
 * The page an insert under `parentId` writes into. Mirrors the reducer's
 * `applyInsert` inference plus the union's translated anchors:
 *
 *  - `null`               → the base page (bare append keeps base semantics).
 *  - a translated anchor  → the mounted page it stands in for.
 *  - a present page shell → the shell IS the page (`parent.id`).
 *  - a present content row → that row's own page.
 *  - absent from the union → `parentId` IS the page row (a top-level insert —
 *    page rows are never part of their own content feed).
 */
export function insertOwnerPage(
  rows: readonly UnionRow[],
  parentId: string | null,
  mounts: Mounts,
  basePageId: string,
): string {
  if (parentId === null) return basePageId;
  const mounted = pageByAnchor(mounts).get(parentId);
  if (mounted !== undefined) return mounted;
  const parent = rows.find((r) => r.id === parentId);
  if (!parent) return parentId;
  if (parent.type === PAGE_BLOCK_TYPE) return parent.id;
  if (parent.pageId === null)
    throw new Error(`Block ${parentId} has no owning page`);
  return parent.pageId;
}

/**
 * The page a structural op writes into. Target rows resolve through the union;
 * an indent/outdent set must be single-page (the keystroke boundary guards
 * ensure it — a mixed set throws rather than half-applying); an insert resolves
 * through its anchor (sibling first, then the parent-scope rule).
 */
export function resolveOpOwnerPage(
  rows: readonly UnionRow[],
  op: BlockOp,
  mounts: Mounts,
  basePageId: string,
): string {
  switch (op.kind) {
    case "split":
    // A splice writes the origin's page: its forest lands beside the origin (or
    // under it), never across a page boundary.
    case "splice":
    case "merge":
    // `unwrap` writes only within one page: it deletes the container and
    // re-ranks its children under the container's OWN parent, all rows of the
    // container's page. So the container's owner is the whole op's owner.
    case "unwrap":
    case "move":
      return rowOwnerPage(rows, op.blockId);
    // A span is one page's op: `normalizeSpan` widens a span reaching across a
    // page boundary to a block selection, so its start line names the page.
    case "deleteSpan":
      return rowOwnerPage(rows, op.targetId);
    case "indent":
    case "outdent":
      return singleOwnerPage(rows, op.blockIds);
    // A bulk move's roots must share a page — the same single-page rule, and
    // the same loud refusal, from the same helper. Its DESTINATION must be that
    // page too: the op endpoint refuses an out-of-page parent with a 400, which
    // would leave a never-confirming op on the lane. The composite routes a
    // cross-page selection drop to `moveBlocks` before it gets here, so a
    // mismatch is a routing bug — fail before it reaches the network.
    case "bulkMove": {
      const owner = singleOwnerPage(rows, op.ids);
      const dest = insertOwnerPage(rows, op.parentId, mounts, basePageId);
      if (dest !== owner) {
        throw new Error(
          `bulkMove from page ${owner} into page ${dest} is cross-page; ` +
            `it must go through the moveBlocks endpoint`,
        );
      }
      return owner;
    }
    // A delete set CAN legitimately span pages (a selection reaching into an
    // expanded sub-page), which `splitOpByOwnerPage` resolves by issuing one op
    // per owner BEFORE this is reached. So by the time a delete gets here it is
    // single-page, and the loud refusal is the right answer if it is not.
    case "delete":
      return singleOwnerPage(rows, op.blockIds);
    case "insert": {
      const anchorId = op.afterId ?? op.beforeId;
      if (anchorId != null) return rowOwnerPage(rows, anchorId);
      return insertOwnerPage(rows, op.parentId ?? null, mounts, basePageId);
    }
    case "paste":
      // Same anchor rule as `insert` — a forest lands wherever a single block
      // inserted at the same anchor would.
      if (op.afterId != null) return rowOwnerPage(rows, op.afterId);
      return insertOwnerPage(rows, op.parentId ?? null, mounts, basePageId);
    case "duplicate":
      // Every clone lands after its own source, so the op's anchors ARE the
      // selection roots: the single-page rule over them is byte-for-byte the
      // cross-page refusal the routed `bulkDuplicate` used to apply at the store
      // seam (same helper, same message).
      return singleOwnerPage(
        rows,
        op.placements.map((p) => p.afterId),
      );
  }
}

/**
 * Route one structural op to the page(s) that own its rows — the op-shaped twin
 * of {@link groupPatchByOwnerPage}.
 *
 * Exactly ONE op kind fans out: a `delete` set, which the user can legitimately
 * build across an expanded sub-page's boundary. Each page then commits its own
 * rows in its own transaction, so the gesture never half-applies inside a page;
 * one gesture is still one undo entry, because recording happens once, upstream,
 * over the union. Every other kind is single-page by construction (its guards
 * refuse a mixed set loudly rather than silently splitting a gesture whose
 * meaning depends on all of it landing together).
 */
export function splitOpByOwnerPage(
  rows: readonly UnionRow[],
  v: Extract<BlockOverlayOp, { tag: "op" }>,
  mounts: Mounts,
  basePageId: string,
): { owner: string; v: BlockOverlayOp }[] {
  if (v.op.kind === "delete") {
    const groups = groupIdsByOwnerPage(rows, v.op.blockIds);
    if (groups.size > 1) {
      return [...groups].map(([owner, blockIds]) => ({
        owner,
        v: narrowDeleteOverlayOp(v, blockIds),
      }));
    }
  }
  return [{ owner: resolveOpOwnerPage(rows, v.op, mounts, basePageId), v }];
}

/**
 * Split a patch into one per-page patch per owning page. Creates carry their
 * own denormalized `pageId` (untouched by union remapping), so they route even
 * when the page's feed is unmounted (the detached-persist path). Updates and
 * delete ids carry no page — a field-scoped update names only what it changes,
 * and `pageId` is never one of those fields — so both resolve through the
 * caller's `ownerOf`: the union first, falling back to the composite's
 * cumulative row→page index for rows that left the union (undo after collapse).
 * An unresolvable id throws.
 */
export function groupPatchByOwnerPage(
  patch: BlockPatch,
  ownerOf: (id: string) => string | null,
): Map<string, BlockPatch> {
  const groups = new Map<string, BlockPatch>();
  const groupFor = (owner: string): BlockPatch => {
    let group = groups.get(owner);
    if (!group) {
      group = { creates: [], updates: [], deleteIds: [] };
      groups.set(owner, group);
    }
    return group;
  };
  const resolve = (id: string, what: string): string => {
    const owner = ownerOf(id);
    if (owner === null) {
      throw new Error(`Cannot resolve the owning page of ${what} ${id}`);
    }
    return owner;
  };
  for (const create of patch.creates) {
    if (create.pageId === null) {
      throw new Error(`Patch create ${create.id} has no owning page`);
    }
    groupFor(create.pageId).creates.push(create);
  }
  for (const update of patch.updates) {
    groupFor(resolve(update.id, "updated block")).updates.push(update);
  }
  for (const id of patch.deleteIds) {
    groupFor(resolve(id, "deleted block")).deleteIds.push(id);
  }
  return groups;
}

/**
 * Translate a patch from union space back to store space. A row whose recorded
 * `parentId` is a page-link anchor is a top-level row of its own page, whose
 * real parent is that page's row — which `anchorPages` resolves directly, for
 * creates (which carry a whole row) and for updates (which carry only the
 * fields they change, `pageId` never among them) alike. `anchorPages` is the
 * CUMULATIVE anchor→page map of every translated mount seen (not just the
 * current mounts): undo patches recorded while a link was expanded replay after
 * it collapsed. Identity (same reference) when nothing rewrites.
 */
export function translatePatchForStore(
  patch: BlockPatch,
  anchorPages: ReadonlyMap<string, string>,
): BlockPatch {
  if (anchorPages.size === 0) return patch;
  let changed = false;
  const creates: BlockPatch["creates"] = [];
  for (const create of patch.creates) {
    const real =
      create.parentId === null ? undefined : anchorPages.get(create.parentId);
    if (real === undefined) {
      creates.push(create);
      continue;
    }
    changed = true;
    creates.push({ ...create, parentId: real });
  }
  const updates: BlockPatch["updates"] = [];
  for (const update of patch.updates) {
    const parentId = update.changes.parentId;
    const real = parentId == null ? undefined : anchorPages.get(parentId);
    if (real === undefined) {
      updates.push(update);
      continue;
    }
    changed = true;
    updates.push({ ...update, changes: { ...update.changes, parentId: real } });
  }
  return changed ? { ...patch, creates, updates } : patch;
}

/**
 * Translate an overlay op from union space to the owning store's space before
 * dispatch: parent anchors on `insert`/`move` ops and on `reparent` effect
 * predictions map back to the real mounted page id; patch rows translate
 * via {@link translatePatchForStore}. Identity — the same reference — when the
 * op references no translated anchor (every sub-page-only union).
 */
export function translateOpForStore(
  v: BlockOverlayOp,
  mounts: Mounts,
  patchAnchorPages?: ReadonlyMap<string, string>,
): BlockOverlayOp {
  const byAnchor = pageByAnchor(mounts);
  if (v.tag === "patch") {
    const patch = translatePatchForStore(v.patch, patchAnchorPages ?? byAnchor);
    // `restoreIds` is keyed by row id, which translation never rewrites.
    return patch === v.patch ? v : { ...v, patch };
  }
  if (byAnchor.size === 0) return v;
  let op = v.op;
  if (
    (op.kind === "insert" ||
      op.kind === "move" ||
      op.kind === "bulkMove" ||
      op.kind === "paste") &&
    op.parentId != null &&
    byAnchor.has(op.parentId)
  ) {
    op = { ...op, parentId: byAnchor.get(op.parentId)! };
  }
  let effect = v.effect;
  if (effect.kind === "reparent") {
    let movesChanged = false;
    const moves: typeof effect.moves = [];
    for (const move of effect.moves) {
      if (move.parentId === null || !byAnchor.has(move.parentId)) {
        moves.push(move);
        continue;
      }
      movesChanged = true;
      moves.push({ ...move, parentId: byAnchor.get(move.parentId)! });
    }
    if (movesChanged) effect = { ...effect, moves };
  }
  // `targets` rides through untouched: it holds BLOCK ids, and only `parentId`
  // values are anchor-translated — a block id means the same row in union space
  // and in its owning store's space.
  return op === v.op && effect === v.effect
    ? v
    : { tag: "op", op, effect, targets: v.targets };
}
