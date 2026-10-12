import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  isDescendant,
  selectionRoots,
  subtreeIds,
} from "@plugins/primitives/plugins/tree/core";
import type { BlockHandle } from "./define-block";
import { PAGE_BLOCK_TYPE, type Block } from "./schemas";
import { planForestInsert, positionalRank, rankWindow } from "./block-forest";
import {
  IdentifiedBlockSchema,
  type IdentifiedBlock,
} from "./serialized-block";
import {
  mergeRuns,
  plainOf,
  runsLength,
  runsOf as coerceRuns,
  splitRuns,
  TextRunSchema,
  type RichText,
} from "./rich-text";

/**
 * JSON-pure subset of a block row used by the reducer. `createdAt`/`updatedAt`
 * stay out of the reducer — the server stamps those during reconcile. `rank` is
 * the stored string form (wrap with `Rank.from` to do math, serialize back with
 * `.toJSON()`).
 */
export type BlockNode = {
  id: string;
  pageId: string | null;
  parentId: string | null;
  type: string;
  data: unknown;
  rank: string;
  expanded: boolean;
};

/**
 * Project full `Block` rows to the reducer's JSON-pure `BlockNode` shape — the
 * ONE adapter between the wire row and the node every helper in this module
 * takes. The structural mismatch is `rank`: a `Block` carries a `Rank` INSTANCE
 * while a `BlockNode` carries its stored string form, so it is serialized here.
 * (`data` differs only in optionality — `z.unknown()` infers an optional key —
 * which is why this cannot be replaced by a structural widening of the helpers:
 * `Rank` is a class, not a string alias.)
 *
 * It lives in `core/` beside both types it maps between, so a read-only consumer
 * outside this plugin — an outline, a walk, an export — can order a forest it
 * holds as `Block[]` without hand-rolling the rank conversion.
 */
export function toNodes(rows: Block[]): BlockNode[] {
  return rows.map((b) => ({
    id: b.id,
    pageId: b.pageId,
    parentId: b.parentId,
    type: b.type,
    data: b.data,
    rank: String(b.rank),
    expanded: b.expanded,
  }));
}

/**
 * The complete set of single-block, in-page tree operations. New blocks carry a
 * client-minted `newId` so client and server compute byte-identical results.
 * Caret/focus is intentionally NOT part of the reducer.
 */
export type BlockOp =
  | {
      kind: "split";
      blockId: string;
      position: number;
      newId: string;
      asChild?: boolean;
      childType?: string;
      /**
       * Sibling block type produced by a non-asChild split at the end of the
       * block's text (e.g. a heading yields a `text` paragraph). Defaults to the
       * original block's type.
       */
      siblingType?: string;
      /**
       * Authoritative per-type-transformed `data` payload for the tail block —
       * e.g. a checked to-do splits into an UNCHECKED tail. Absent = inherit the
       * origin's `data` (today's behavior). It is resolved at the INTENT layer
       * (via a block handle's `dataOnSplit`), not here, because the pure reducer
       * cannot see block handles; a bad payload is caught by the strict
       * `parseBlockData` normalizer at the server write boundary (loud 400). The
       * reducer always overwrites `.text` with `afterRuns`, so only the
       * non-text fields of `tailData` survive.
       */
      tailData?: unknown;
      /**
       * Authoritative current rich-text runs from the editor; falls back to the
       * stored block runs (`runsOfNode`) when absent. Lets the reducer split the
       * live (doc-fresh, projection may lag ~1s) content rather than the lagged
       * projection. The LIVE split path ALWAYS sets this; the fallback is reached
       * only by the pure reducer (tests / non-live callers), for whom `data.text`
       * IS the intended basis — so the fallback must stay.
       */
      runs?: RichText;
    }
  | {
      kind: "merge";
      blockId: string;
      /**
       * Authoritative current rich-text runs of the merging block from the
       * editor; falls back to the stored block runs (`runsOfNode`) when absent.
       * Same seam as split: LIVE merge always supplies this, the fallback is the
       * pure reducer's projection basis — do not remove it.
       */
      runs?: RichText;
    } // merge into prev sibling
  /**
   * Nest each of `blockIds` under its previous sibling. Indentation is a SET
   * operation — a single Tab in a block's text editor is simply the one-element
   * case — so the whole selected run moves as one rigid body (see `foldIndent`).
   */
  | { kind: "indent"; blockIds: string[] }
  /** Lift each of `blockIds` out to its parent's level (see `foldOutdent`). */
  | { kind: "outdent"; blockIds: string[] }
  | {
      kind: "insert";
      newId: string;
      type: string;
      data?: unknown;
      // Placement, in precedence order: after a sibling, before a sibling, or
      // appended as the last child of `parentId`. `afterId`/`beforeId` both
      // inherit the named sibling's parent.
      afterId?: string | null;
      beforeId?: string | null;
      parentId?: string | null;
    }
  /**
   * Delete each id's whole subtree. A SET operation for the reason `indent` /
   * `outdent` are: pressing Backspace on one block is the one-element case of
   * deleting a block selection, so one gesture stays ONE op, ONE undo entry and
   * ONE server transaction however many roots it names. Ids absent from the
   * forest are skipped; a fully-absent set is an identity no-op.
   */
  | { kind: "delete"; blockIds: string[] }
  /**
   * Dissolve a container in place: delete `blockId` and PROMOTE its children into
   * the slot it occupied among its own former siblings. Children keep their ids,
   * types, `data` and subtrees — only `parentId` and `rank` change — and their
   * order is preserved.
   *
   * This is how the caret escapes a container. The generic Backspace ladder would
   * otherwise resolve "start of the first child" to its `isIndented` → **outdent**
   * rung, and out of a container `outdentOne` lands the line AFTER the box: the
   * first line would jump below the rest of the container's content. Correct for
   * a one-line container, wrong for every other one. `unwrap` removes only the
   * container.
   */
  | { kind: "unwrap"; blockId: string }
  /**
   * Move ONE block to a position among `parentId`'s children — POSITIONAL
   * intent, never a rank.
   *
   * `page_blocks` has a single `(parent_id, rank)` ordering space that several
   * live resources project disjointly, so a rank minted over the rows one writer
   * happens to hold collides with the siblings it cannot see. Both sides
   * therefore mint their own key from `(parentId, targetId, zone)` via
   * `positionalRank`, and — as for `split` and `paste` — the server's stays
   * authoritative while the client's drives the overlay.
   *
   * The destination sibling space MUST lie inside the op's own page, which is
   * what makes the two mints agree. A cross-page drop is not one page's op (no
   * per-page overlay can predict it) and takes the id-scoped `moveBlock`
   * endpoint instead; the composite store is where that fork lives, and the
   * server refuses an out-of-page destination loudly.
   */
  | {
      kind: "move";
      blockId: string;
      parentId: string | null;
      /** The sibling to land beside; `null` addresses the list boundary. */
      targetId: string | null;
      zone: "before" | "after";
    }
  /**
   * Move a whole selection under `parentId`, immediately after `afterId` (or at
   * the start of that sibling list when null) — the drag of a block selection.
   *
   * Positional intent for `move`'s reason; the rank/order algebra is
   * `planBulkMove`, which both sides run over the forest they hold. A refused
   * plan (empty selection, a destination inside the selection or its own
   * subtree) is the identity, so a refused drag never reaches the undo stack or
   * the network — the same discipline every other refused op follows.
   */
  | {
      kind: "bulkMove";
      ids: string[];
      parentId: string | null;
      afterId: string | null;
    }
  /**
   * Insert a whole forest (a clipboard paste, a file drop) as a sibling run.
   * The forest arrives with its ids ALREADY minted (`withMintedIds`), which is
   * exactly what lets a paste be an op rather than a bespoke endpoint: both
   * sides run `planForestInsert` over it and agree on every row's identity, so
   * the client can overlay the result immediately and the server's push is a
   * no-op confirmation instead of the first time the user sees their content.
   */
  | {
      kind: "paste";
      forest: IdentifiedBlock[];
      /** Insert after this block, inheriting its parent. */
      afterId: string | null;
      /**
       * Destination parent when `afterId` is null. The page's own id addresses
       * the content top level (page rows are excluded from the reducer's
       * forest, so a top-level insert is physically parented to the page).
       */
      parentId?: string | null;
    }
  /**
   * Duplicate a block selection: each placement clones one selection root's
   * subtree and lands it immediately after that root. Ids are minted CLIENT-side
   * (`withMintedIds`) for the same reason paste mints them — it is what lets both
   * sides plan the same rows and the client overlay the result immediately.
   *
   * No `parentId` on a placement, deliberately: a clone always lands after its
   * source, so the destination is never anchor-less. Keep it that way —
   * `translateOpForStore` only rewrites `parentId` for the kinds that have one, so
   * adding the field here would silently skip anchor translation.
   */
  | {
      kind: "duplicate";
      placements: { afterId: string; forest: IdentifiedBlock[] }[];
    }
  /**
   * Splice a forest INTO a block's text at an insertion point — a caret paste,
   * or a drop inside a block's text (see `planSplice` for the whole rule):
   *
   * > the text before the point keeps its line and absorbs the forest's leading
   * > plain paragraph; the text after the point goes to the end of the forest's
   * > last plain paragraph (or to a tail line minted like split's); everything
   * > else lands in between.
   *
   * One op, so one undo entry and one server transaction, where the gesture
   * used to be a `paste` AFTER the caret's block that left the caret's own text
   * where it was. It is split and paste fused, and it borrows from each: `runs`
   * / `position` / `siblingType` / `tailData` / `tailId` mean exactly what
   * split's `runs` / `position` / `siblingType` / `tailData` / `newId` mean,
   * and `forest` is paste's (ids minted client-side, travelling on the node).
   */
  | {
      kind: "splice";
      /** The block holding the insertion point. */
      blockId: string;
      /** Linear offset in `runs` (the stored-runs basis, split's). */
      position: number;
      /**
       * The block's LIVE runs, with a selected range already removed
       * (`runsWithoutSpan`) — split's `runs`, but REQUIRED: a splice is only
       * ever issued by a live editor, so there is no projection fallback to
       * keep.
       */
      runs: RichText;
      forest: IdentifiedBlock[];
      /**
       * What the forest was copied AS — see {@link ForestGranularity}. `"text"`
       * splices it into the line; `"blocks"` lands it as whole lines.
       */
      granularity: ForestGranularity;
      /**
       * Pre-minted id for a TAIL line, used only when the text after the point
       * has no plain paragraph to land on. Minted whether or not it is used,
       * for split's `newId` reason: both sides must agree on the row's identity
       * before either knows whether it exists.
       */
      tailId: string;
      /** The tail's type — split's `siblingType` (`BlockHandle.splitInto`). */
      siblingType?: string;
      /** The tail's `data` — split's `tailData` (`BlockHandle.dataOnSplit`). */
      tailData?: unknown;
    }
  /**
   * Delete an editor-owned text span that crosses blocks — from mid-line A to
   * mid-line C — as ONE op, so one gesture is one undo entry and one server
   * transaction (three ops — truncate A, delete the middle, merge C — would let
   * another client observe, and a failure leave, a half-applied edit).
   *
   * The lines BETWEEN A and C are deliberately not a parameter: the reducer
   * derives them as the visible lines strictly between the two, so a client
   * cannot name a set that disagrees with the forest (`applyDeleteSpan`).
   */
  | {
      kind: "deleteSpan";
      /** A — the line the span starts in. Keeps its id, receives the join. */
      targetId: string;
      /** C — the line the span ends in. Merged into A and trashed. */
      sourceId: string;
      /**
       * A's LIVE runs after the delete: A's text before the span joined to C's
       * text after it (`joinAroundSpan`). The whole result rather than C's
       * tail alone, because only the client knows where in A the span starts —
       * a tail alone would be appended to A's ENTIRE (lagged) projection.
       * Required, for `splice`'s reason: only a live editor issues it.
       */
      runs: RichText;
    };

/**
 * What a forest arriving at an insertion point was copied AS, which decides how
 * it meets the line it lands in:
 *
 *  - `"text"` — text (external text, markdown, a text range): SPLICED into the
 *    line, its leading paragraph joining the text before the point and the text
 *    after the point joining its last paragraph;
 *  - `"blocks"` — whole blocks (a block-selection copy, a bare-caret copy of the
 *    caret's block): whole LINES, never merged into anyone's text.
 *
 * A fact about the COPY, carried by the payload (`BLOCKS_MIME`'s envelope) —
 * never inferred from the forest's shape, where one copied paragraph and one
 * pasted line of text are the same node.
 */
export type ForestGranularity = "text" | "blocks";

/**
 * Type facts the pure reducer cannot derive from the forest alone. Parameterized
 * on DATA rather than importing a slot — the precedent `core/markdown.ts` sets
 * ("Parameterized on `handles`, not a slot import, so it stays a leaf both
 * runtimes can call"): the web side builds it from the `Editor.Block`
 * contributions, the server from its own block registry, and neither runtime's
 * registry leaks into the other.
 *
 * Every field is optional and the default (`{}` — an empty anchor set) makes
 * `applyBlockOp` byte-identical to a context-free call. That is the property that
 * keeps every existing test, property test and fuzz seed valid.
 */
export interface BlockOpContext {
  /**
   * Block types declaring `BlockHandle.anchor` — containers that render no line
   * of their own. The reducer needs them for four things: refusing to split one
   * (it hosts no text), refusing to merge into or away one (same), pruning a
   * container the last child just left, and resolving VISIBILITY — an anchor
   * borrows its first child's line, so `visibleChildRule` (and therefore
   * `prevVisibleLine` / `nextVisibleLine`) cannot answer without knowing which
   * types are anchors.
   */
  anchorTypes?: ReadonlySet<string>;
  /**
   * Block types whose schema declares `text` (`BlockHandle.acceptsText`). The
   * reducer needs them for one thing: refusing to merge INTO a text-less row,
   * which would write `data.text` onto a void schema and 400 at the write
   * boundary. `anchorTypes` already covers the container half of that; this
   * covers the rest (divider, image, embed, place, …).
   *
   * ABSENT MEANS "NO OPINION", NOT "NOTHING ACCEPTS TEXT" — and unlike
   * `anchorTypes` the empty-set default would be catastrophic here (it would
   * refuse EVERY merge), which is why the refusal below gates on presence. A
   * caller that cannot resolve the registry gets today's behavior, and the write
   * boundary stays the thing that rejects loudly. Same stance the row-write
   * funnel takes for a type with no registered handle.
   */
  textBearingTypes?: ReadonlySet<string>;
  /**
   * The block type declaring `BlockHandle.defaultText` — the plain paragraph.
   * The reducer needs it for one op, `splice`: only a plain paragraph has an
   * inline form, so only one can be absorbed into the line at the insertion
   * point (or take the text after it), and only an empty one is consumed by
   * what lands in its place. Derived from the registry, never named: the
   * editor core does not know which plugin ships the paragraph.
   *
   * Absent (a composition shipping no default text type, or a context-free
   * call) means no node is a plain paragraph, and a splice degenerates to a
   * split with the forest inserted between the two halves.
   */
  defaultTextType?: string;
}

/**
 * The one derivation of a {@link BlockOpContext} from a block-handle set.
 *
 * Both runtimes MUST hand `applyBlockOp` the same context: the client predicts
 * the forest with it (the optimistic overlay) and the server commits with it, so
 * a disagreement makes an op apply differently on each side and never confirm.
 * That parity used to be a convention — two filters, one per runtime, that had
 * to be kept in step by hand. Deriving both from this function makes it
 * structural: the registries differ, the derivation cannot.
 */
export function blockOpContextOf(
  handles: readonly BlockHandle<unknown>[],
): BlockOpContext {
  return {
    anchorTypes: new Set(handles.filter((h) => h.anchor).map((h) => h.type)),
    textBearingTypes: new Set(
      handles.filter((h) => h.acceptsText).map((h) => h.type),
    ),
    defaultTextType: handles.find((h) => h.defaultText)?.type,
  };
}

/** The default context: no anchor types, i.e. today's behavior exactly. */
const NO_ANCHORS: ReadonlySet<string> = new Set<string>();

/**
 * Adapt the reducer's `anchorTypes` set to the `IsAnchor` predicate the
 * visibility helpers take. One conversion point, so the two spellings of the
 * same fact can never drift.
 */
function anchorOf(anchorTypes: ReadonlySet<string>): IsAnchor {
  return (node) => anchorTypes.has(node.type);
}

/**
 * Zod discriminated union mirroring `BlockOp`, for server body validation. The
 * explicit `ZodParser<BlockOp>` annotation pins the inferred output to the full
 * union — without it, `defineEndpoint`'s `SpecType<B>` extraction collapses a
 * discriminated union to its last member.
 */
export const BlockOpSchema: ZodParser<BlockOp> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("split"),
    blockId: z.string(),
    position: z.number().int().nonnegative(),
    newId: z.string(),
    asChild: z.boolean().optional(),
    childType: z.string().optional(),
    siblingType: z.string().optional(),
    tailData: z.unknown().optional(),
    runs: z.array(TextRunSchema).optional(),
  }),
  z.object({
    kind: z.literal("merge"),
    blockId: z.string(),
    runs: z.array(TextRunSchema).optional(),
  }),
  z.object({ kind: z.literal("indent"), blockIds: z.array(z.string()).min(1) }),
  z.object({
    kind: z.literal("outdent"),
    blockIds: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("insert"),
    newId: z.string(),
    type: z.string(),
    data: z.unknown().optional(),
    afterId: z.string().nullable().optional(),
    beforeId: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal("delete"), blockIds: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("unwrap"), blockId: z.string() }),
  z.object({
    kind: z.literal("move"),
    blockId: z.string(),
    parentId: z.string().nullable(),
    targetId: z.string().nullable(),
    zone: z.enum(["before", "after"]),
  }),
  z.object({
    kind: z.literal("bulkMove"),
    ids: z.array(z.string()).min(1),
    parentId: z.string().nullable(),
    afterId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("paste"),
    forest: z.array(IdentifiedBlockSchema),
    afterId: z.string().nullable(),
    parentId: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("duplicate"),
    placements: z.array(
      z.object({ afterId: z.string(), forest: z.array(IdentifiedBlockSchema) }),
    ),
  }),
  z.object({
    kind: z.literal("splice"),
    blockId: z.string(),
    position: z.number().int().nonnegative(),
    runs: z.array(TextRunSchema),
    forest: z.array(IdentifiedBlockSchema).min(1),
    granularity: z.enum(["text", "blocks"]),
    tailId: z.string(),
    siblingType: z.string().optional(),
    tailData: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("deleteSpan"),
    targetId: z.string(),
    sourceId: z.string(),
    runs: z.array(TextRunSchema),
  }),
]);

// ---------------------------------------------------------------------------
// Pure helpers — the single source of rank/tree math.
// ---------------------------------------------------------------------------

/** Nothing is leaving the sibling list — an insert bounds itself on every sibling. */
const NO_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

/** Children of `parentId`, sorted ascending by rank. */
export function childrenOf(
  blocks: BlockNode[],
  parentId: string | null,
): BlockNode[] {
  return blocks
    .filter((b) => b.parentId === parentId)
    .sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)));
}

/** The rank-immediate previous sibling of `node` (null if it is first). */
export function prevSibling(
  blocks: BlockNode[],
  node: BlockNode,
): BlockNode | null {
  const siblings = childrenOf(blocks, node.parentId);
  const idx = siblings.findIndex((s) => s.id === node.id);
  if (idx <= 0) return null;
  return siblings[idx - 1] ?? null;
}

/**
 * Is this node a container ANCHOR — a type that renders no line of its own,
 * whose content IS its children? Passed as a predicate rather than the
 * `anchorTypes` set so the web resolver can hand over its existing
 * `IntentContext.isAnchor` unchanged; `applyBlockOp` adapts its set at the
 * boundary. The default (`NOT_ANCHOR`) makes every visibility helper below
 * byte-identical to the pre-container behavior — the property that keeps every
 * existing test and fuzz seed valid.
 */
export type IsAnchor = (node: BlockNode) => boolean;

const NOT_ANCHOR: IsAnchor = () => false;

/**
 * THE visible-children rule, for one node, in one place — the normative
 * statement of what a collapsed CONTAINER shows.
 *
 * A container anchor renders no line of its own, so it borrows its first child's
 * (that is already how it seats its gutter decoration, and who owns that line's
 * rail — `internal/rail-seat.ts` in the surface). Collapse borrows the SAME
 * line, which makes folding a
 * container the identical rule every ordinary block already follows — "hide
 * everything below my own line":
 *
 * - **R1** — an anchor ALWAYS descends into its first child, collapsed or not.
 *   Its own line IS that child's, so refusing to descend would hide the line
 *   itself and leave a zero-height row: content behind nothing, which is exactly
 *   the failure that used to force `collapsible: "never"`.
 * - **R2** — the borrowed line of a COLLAPSED anchor shows no children and no
 *   following siblings. `sealed` carries that fact down the walk.
 *
 * The consequence worth stating out loud, because it is what makes the fold
 * safe: a collapsed container ALWAYS paints exactly one visible line. Content
 * can never hide behind an invisible control, whatever a stray `expanded: false`
 * from a hand-written PATCH or a pasted `SerializedBlock` says.
 *
 * Returns the rule's answer only — each caller supplies its own child lookup, so
 * the surface can walk its already-built `TreeNode` forest (no per-node
 * `childrenOf` scan on every render) while the reducer walks the flat array.
 * One rule, two lookups; `block-ops.test.ts` cross-checks the two against each
 * other over the fuzz forest.
 */
export function visibleChildRule(opts: {
  isAnchor: boolean;
  expanded: boolean;
  /** Is this node already inside a collapsed anchor's borrowed chain? */
  sealed: boolean;
  hasChildren: boolean;
}): { show: "none" | "first" | "all"; sealedBelow: boolean } {
  const { isAnchor, expanded, sealed, hasChildren } = opts;
  if (!hasChildren) return { show: "none", sealedBelow: sealed };
  const open = expanded && !sealed;
  // R1: an anchor descends into its first child either way — that child is its line.
  if (isAnchor)
    return { show: open ? "all" : "first", sealedBelow: sealed || !expanded };
  // R2: a sealed line is the borrowed line itself; nothing below it shows.
  return { show: open ? "all" : "none", sealedBelow: sealed };
}

/**
 * The anchors ABOVE `node` in its FIRST-CHILD chain, innermost first — every
 * container whose borrowed line is `node`. Rank-first at each step: a later child
 * is an ordinary line inside the box, not the box's borrowed one.
 */
function anchorChainAbove(
  blocks: BlockNode[],
  node: BlockNode,
  isAnchor: IsAnchor,
): BlockNode[] {
  const out: BlockNode[] = [];
  let cur = node;
  for (;;) {
    if (cur.parentId === null) return out;
    const parent = byId(blocks, cur.parentId);
    if (!parent || !isAnchor(parent)) return out;
    if (childrenOf(blocks, parent.id)[0]?.id !== cur.id) return out;
    out.push(parent);
    cur = parent;
  }
}

/**
 * The OUTERMOST collapsed anchor whose borrowed line is `node`, or null.
 *
 * Outermost, not innermost, and that is load-bearing: R2 says the borrowed line
 * has no visible following siblings, so a sibling walk starting at `node` must
 * resume above the last container that hides them. Resuming at the innermost
 * would step to a sibling that is itself still inside a collapsed box.
 */
export function collapsedAnchorAbove(
  blocks: BlockNode[],
  node: BlockNode,
  isAnchor: IsAnchor = NOT_ANCHOR,
): BlockNode | null {
  const collapsed = anchorChainAbove(blocks, node, isAnchor).filter(
    (a) => !a.expanded,
  );
  return collapsed[collapsed.length - 1] ?? null;
}

/**
 * `node`'s children in VISIBLE document order — `visibleChildRule` resolved
 * against the flat forest. The reducer's and the ladders' single visibility
 * question; the surface's flatten answers the same one over its tree.
 */
export function visibleChildrenOf(
  blocks: BlockNode[],
  node: BlockNode,
  isAnchor: IsAnchor = NOT_ANCHOR,
): BlockNode[] {
  const kids = childrenOf(blocks, node.id);
  const { show } = visibleChildRule({
    isAnchor: isAnchor(node),
    expanded: node.expanded,
    sealed: collapsedAnchorAbove(blocks, node, isAnchor) !== null,
    hasChildren: kids.length > 0,
  });
  if (show === "none") return [];
  return show === "all" ? kids : [kids[0]!];
}

/**
 * Open every collapsed container hiding what surrounds `node` — the reducer half
 * of *content lands where it can be seen*.
 *
 * An op that writes a new line next to `node` (split, and the move/drop paths on
 * the client) would otherwise place it where R2 hides it: not flattened, no
 * `BlockRow`, no Lexical instance — while the executor has already truncated the
 * origin's live doc and queued focus at the new id. The text after the caret
 * would simply vanish. Opening first makes the op mean what the same op means
 * anywhere else, and matches what `applyInsert`/`applyPaste`/`applyMove` have
 * always done to their destination parent.
 */
function revealAround(
  blocks: BlockNode[],
  node: BlockNode,
  isAnchor: IsAnchor,
): BlockNode[] {
  let next = blocks;
  for (const anchor of anchorChainAbove(blocks, node, isAnchor)) {
    if (!anchor.expanded) next = replace(next, { ...anchor, expanded: true });
  }
  return next;
}

/**
 * The previous block in VISIBLE document order: the deepest last visible
 * descendant of `node`'s previous sibling. When `node` has NO previous sibling,
 * the visible line directly above it is its PARENT — so walk one step up (null at
 * the forest root). "Line", not "leaf": with the upward branch it can return a
 * parent, not only a leaf. Stops descending where visibility stops, so the result
 * is exactly the block whose end the caret would land at when crossing up. The
 * exact dual of `nextVisibleLine`, so
 * `prevVisibleLine(nextVisibleLine(X)) === X` for every X with a next line.
 *
 * "Last visible descendant" is `visibleChildrenOf`, not `expanded`: a COLLAPSED
 * container's last visible line is its BORROWED one (its first child's), so the
 * descent takes the first child there and the last child everywhere else. Getting
 * this wrong breaks duality in exactly one place — Delete at the end of a
 * collapsed container's line would resolve a merge the reducer then refuses,
 * i.e. a consumed keystroke that silently does nothing.
 */
export function prevVisibleLine(
  blocks: BlockNode[],
  node: BlockNode,
  isAnchor: IsAnchor = NOT_ANCHOR,
): BlockNode | null {
  let cur = prevSibling(blocks, node);
  if (!cur) return node.parentId ? (byId(blocks, node.parentId) ?? null) : null;
  for (;;) {
    const kids = visibleChildrenOf(blocks, cur, isAnchor);
    const last = kids[kids.length - 1];
    if (!last) return cur;
    cur = last;
  }
}

/**
 * The next block in VISIBLE document order — the exact dual of `prevVisibleLine`:
 * the first visible child (`visibleChildrenOf`, so an anchor yields its borrowed
 * line whether or not it is collapsed), else the nearest following sibling found
 * by walking up through ancestors. Null at the end of the
 * forest. Like its dual it stops at a page boundary naturally: a sub-page's
 * subtree lives in another `page_id` partition and is simply absent from `blocks`.
 */
export function nextVisibleLine(
  blocks: BlockNode[],
  node: BlockNode,
  isAnchor: IsAnchor = NOT_ANCHOR,
): BlockNode | null {
  // first visible child, else the nearest following sibling walking up
  const kids = visibleChildrenOf(blocks, node, isAnchor);
  if (kids[0]) return kids[0];
  // R2: the borrowed line of a collapsed container has no visible following
  // siblings either — they are inside the box it folded. Resume the upward walk
  // ABOVE the outermost container hiding them, so the next line is the one after
  // the whole box.
  let cur: BlockNode | null =
    collapsedAnchorAbove(blocks, node, isAnchor) ?? node;
  while (cur) {
    const sib = nextSibling(blocks, cur);
    if (sib) return sib;
    cur = cur.parentId ? (byId(blocks, cur.parentId) ?? null) : null;
  }
  return null;
}

/** The rank-immediate next sibling of `node` (null if it is last). */
export function nextSibling(
  blocks: BlockNode[],
  node: BlockNode,
): BlockNode | null {
  const siblings = childrenOf(blocks, node.parentId);
  const idx = siblings.findIndex((s) => s.id === node.id);
  if (idx === -1) return null;
  return siblings[idx + 1] ?? null;
}

/** Look up a block by id (undefined if absent). */
export function byId(blocks: BlockNode[], id: string): BlockNode | undefined {
  return blocks.find((b) => b.id === id);
}

/** Last element of `arr`, or null when empty (avoids `Array.prototype.at`). */
function lastOf<T>(arr: readonly T[]): T | null {
  return arr.length > 0 ? arr[arr.length - 1]! : null;
}

/** Coerce a block's jsonb payload (typed `unknown`) into a plain object. */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The block's text payload flattened to a plain string, or "" when it has none.
 * Reads `data.text` (which may be a legacy string or structured runs) through the
 * rich-text normalizer. Used where a plain title/preview is needed (e.g.
 * turn-into-page) — structural ops use `runsOfNode`/`withRuns`.
 */
export function textOf(node: { data?: unknown }): string {
  return plainOf(asObject(node.data).text);
}

/**
 * The block's text payload as structured rich-text runs (coerced; `[]` when none).
 *
 * Reads `data.text`, the debounced projection of the live content doc — it lags
 * the doc by up to ~1s. That lag is by design here: this is only the reducer's
 * FALLBACK basis (`op.runs ?? runsOfNode(...)` at the split/merge seams). Every
 * LIVE caller supplies `op.runs` (authoritative current runs from the bound
 * editor), so the projection is never used on the live path; reducer-only / test
 * callers, which operate from row data alone, accept the projection basis by
 * construction.
 */
export function runsOfNode(node: { data?: unknown }): RichText {
  return coerceRuns(asObject(node.data).text);
}

/** A copy of `node` with `data.text` set to `runs` (spreads existing data). */
export function withRuns(node: BlockNode, runs: RichText): BlockNode {
  return { ...node, data: { ...asObject(node.data), text: runs } };
}

/** Immutable replace: return a new array with the node of `next.id` swapped. */
export function replace(blocks: BlockNode[], next: BlockNode): BlockNode[] {
  return blocks.map((b) => (b.id === next.id ? next : b));
}

/** Immutable remove: return a new array without the given ids. */
export function remove(
  blocks: BlockNode[],
  ids: ReadonlySet<string> | string[],
): BlockNode[] {
  const set = ids instanceof Set ? ids : new Set(ids);
  return blocks.filter((b) => !set.has(b.id));
}

/** Immutable add: return a new array with `node` appended. */
export function add(blocks: BlockNode[], node: BlockNode): BlockNode[] {
  return [...blocks, node];
}

/**
 * Every node in visible document (top-to-bottom) order: a rank-ordered DFS from
 * the forest roots, descending into collapsed subtrees too (structure, not
 * visibility, is what the reducer folds over).
 *
 * A block's `rank` is only comparable against its OWN siblings — a global rank
 * sort is therefore NOT document order. The bulk indent/outdent folds depend on
 * true document order to compose, so this is the one place that derives it.
 */
function documentOrder(blocks: BlockNode[]): string[] {
  const present = new Set(blocks.map((b) => b.id));
  // Forest roots: nodes whose parent is outside this array (the page row is not
  // part of a page's content forest) or absent entirely.
  const roots = blocks
    .filter((b) => b.parentId === null || !present.has(b.parentId))
    .sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)));
  const out: string[] = [];
  const walk = (node: BlockNode): void => {
    out.push(node.id);
    for (const child of childrenOf(blocks, node.id)) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** `ids` sorted top-to-bottom in document order; ids absent from the forest are dropped. */
export function inDocumentOrder(
  blocks: BlockNode[],
  ids: readonly string[],
): string[] {
  const wanted = new Set(ids);
  return documentOrder(blocks).filter((id) => wanted.has(id));
}

/**
 * A block selection with every FULLY-COVERED container ANCHOR added to it.
 *
 * > A container renders no line of its own, so a selection covering every line
 * > it owns IS a selection of the container.
 *
 * That is not a convenience — it is the ONLY way a pointer can say "this card".
 * An anchor's row is zero height while its children are visible, it carries no
 * rail and no shift-click target, and `rowAtPointer`'s height guard skips it
 * outright: a drag, a shift-click and a click-and-extend can therefore reach
 * every line INSIDE a callout or a `/todo` and never the box around them. Left
 * unresolved, "select the card, copy, paste" pasted its contents with the box
 * stripped off, and the same hole made a drag carry the children out of a frame
 * the user thought they were moving.
 *
 * Coverage is measured against `visibleChildRule` — the lines actually on
 * screen, not the stored children — so a COLLAPSED container is promoted by its
 * one borrowed line. Selecting that line is selecting everything the container
 * shows, which is exactly what the fold means.
 *
 * The walk is post-order, so nesting resolves in one pass: a card whose only
 * content is another card promotes the inner one first, which is then what
 * covers the outer. A childless anchor is never promoted — it has a real
 * one-line box of its own (the surface's childless fallback) and is selected by
 * pointing at it, like any other row.
 *
 * Monotone by construction: it only ever ADDS ids. An anchor the range already
 * carries (a range crossing it from outside, `⌘A`) stays selected whether or not
 * its children are — the roots below then subsume them, which is ordinary
 * subtree semantics and not this rule's business.
 */
export function withContainersSelected(
  blocks: BlockNode[],
  selectedIds: ReadonlySet<string>,
  isAnchor: IsAnchor,
): ReadonlySet<string> {
  const kids = new Map<string | null, BlockNode[]>();
  for (const b of blocks) {
    const list = kids.get(b.parentId);
    if (list) list.push(b);
    else kids.set(b.parentId, [b]);
  }
  for (const list of kids.values())
    list.sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)));

  const out = new Set(selectedIds);
  const walk = (node: BlockNode, sealed: boolean): void => {
    const children = kids.get(node.id) ?? [];
    const anchored = isAnchor(node);
    const { show, sealedBelow } = visibleChildRule({
      isAnchor: anchored,
      expanded: node.expanded,
      sealed,
      hasChildren: children.length > 0,
    });
    const visible =
      show === "all" ? children : show === "first" ? children.slice(0, 1) : [];
    for (const child of visible) walk(child, sealedBelow);
    // Post-order: `out` already carries whatever the children promoted.
    if (anchored && visible.length > 0 && visible.every((c) => out.has(c.id)))
      out.add(node.id);
  };

  // Forest roots: nodes whose parent is outside this array (the page row is not
  // part of a page's content forest) or absent entirely — `documentOrder`'s rule.
  const present = new Set(blocks.map((b) => b.id));
  for (const b of blocks) {
    if (b.parentId === null || !present.has(b.parentId)) walk(b, false);
  }
  return out;
}

/**
 * THE selection roots of a block selection: `selectionRoots` over the
 * container-closed selection (`withContainersSelected`).
 *
 * Every bulk gesture the block list drives — copy, cut, duplicate, drag, move,
 * indent/outdent, the paste anchor — resolves its targets through here, so a
 * fully-covered container travels as the container in ALL of them rather than in
 * whichever ones remembered to close over anchors. `isAnchor` is REQUIRED: there
 * is no anchor-blind spelling of "the selection's roots" for this surface, which
 * is what the defect it fixes was.
 */
export function blockSelectionRoots(
  blocks: BlockNode[],
  selectedIds: ReadonlySet<string>,
  isAnchor: IsAnchor,
): string[] {
  return selectionRoots(
    blocks,
    withContainersSelected(blocks, selectedIds, isAnchor),
  );
}

/**
 * Where a paste lands while a block selection is active: as a sibling AFTER the
 * last selected subtree root in DOCUMENT order, falling back to the caret's own
 * block when nothing is selected.
 *
 * Not the range's head — that is the selection's MOVING end, which is the TOP of
 * the run whenever the user extended upward, and anchoring there drops the copies
 * inside the run it was meant to follow. Document order is direction-independent
 * by construction, so how the range was built cannot matter.
 *
 * Roots, not the last selected id: an insert after a root lands after that root's
 * entire subtree, so a selected parent's descendants are never split. A selection
 * spanning branches therefore anchors on whichever root is document-last — the
 * copies land as its siblings, nested where it is nested. That is "after the end
 * of the selection" read literally, and matches how the selection's other bulk
 * ops treat roots.
 *
 * Roots in `blockSelectionRoots`' sense, so a paste under a fully-selected
 * container lands AFTER the card rather than inside it, after its last child.
 */
export function pasteAnchorId(
  blocks: BlockNode[],
  selectedIds: ReadonlySet<string>,
  focusedBlockId: string | null,
  isAnchor: IsAnchor,
): string | null {
  const roots = blockSelectionRoots(blocks, selectedIds, isAnchor);
  return lastOf(inDocumentOrder(blocks, roots)) ?? focusedBlockId ?? null;
}

/**
 * The ids a `BlockOp` NAMES — a pure function of the op, so it can only report
 * what the op mentions. **It is never a write set.** The reducer writes rows the
 * op says nothing about: a merge rewrites its unnamed target, a split adopts the
 * origin's visible children, a delete cascades subtrees, an unwrap promotes them.
 * The write set is `writtenIds(before, after)` (`core/block-diff.ts`), measured
 * from the reducer's own output, and the overlay's `predictOp` unions the two.
 *
 * Both consumers want the NAMING, and both are sound with a superset: the
 * server's notify path derives which block types a write touched, and the
 * overlay adds these ids to the measured set (never intersects with it).
 */
export function opNamedIds(op: BlockOp): string[] {
  switch (op.kind) {
    case "split":
      return [op.blockId, op.newId];
    case "insert":
      return [op.newId];
    case "merge":
    case "move":
    // `unwrap` also re-ranks the promoted children, which the op does not name:
    // it names the container it dissolves. The reducer's diff is what reports
    // the promotion.
    case "unwrap":
      return [op.blockId];
    case "indent":
    case "outdent":
    case "delete":
      return op.blockIds;
    // The selection's whole id set, not just its roots: naming a block the
    // reducer may refuse to move is sound for both consumers, and the roots are
    // the reducer's to compute anyway.
    case "bulkMove":
      return op.ids;
    case "paste":
      // ROOT ids only, and that is a statement about NAMING, not about coverage:
      // the whole planned forest lands in ONE transaction, so a root names the
      // insertion its descendants ride on. Listing every node would grow this
      // (and the O(n) scans keyed off it) with the size of the paste; the rows
      // the insert really wrote are `writtenIds`' answer, and it does list them.
      return op.forest.map((n) => n.id);
    case "duplicate":
      // Every placement's ROOT ids, for paste's reason: each clone's forest
      // lands in the same one transaction as its root.
      return op.placements.flatMap((p) => p.forest.map((n) => n.id));
    case "splice":
      // The origin, the forest's ROOTS (paste's reason) and the pre-minted tail
      // — named whether or not the reducer uses them, which is sound: a named
      // id the reducer did not write only widens the op's target set.
      return [op.blockId, ...op.forest.map((n) => n.id), op.tailId];
    case "deleteSpan":
      // The two ends. The lines between them are the reducer's to derive (and
      // the measured diff reports them), exactly as merge's target is.
      return [op.targetId, op.sourceId];
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply a single block op to the full in-memory page block list, purely. Never
 * mutates `blocks` (returns a new array with new node objects for changed
 * nodes), and never changes a surviving node's `pageId` (in-page invariant).
 *
 * `ctx` carries the type facts the forest cannot supply (which types are
 * container anchors, and which carry text). It defaults to `{}`, which is
 * byte-identical to a context-free call — see `BlockOpContext`, and mint it with
 * `blockOpContextOf` rather than by hand.
 */
export function applyBlockOp(
  blocks: BlockNode[],
  op: BlockOp,
  ctx: BlockOpContext = {},
): BlockNode[] {
  const anchorTypes = ctx.anchorTypes ?? NO_ANCHORS;
  const next = applyOp(blocks, op, anchorTypes, ctx);
  return pruneEmptyAnchors(next, anchorTypes);
}

function applyOp(
  blocks: BlockNode[],
  op: BlockOp,
  anchorTypes: ReadonlySet<string>,
  ctx: BlockOpContext,
): BlockNode[] {
  const textBearingTypes = ctx.textBearingTypes;
  switch (op.kind) {
    case "split":
      return applySplit(blocks, op, anchorTypes);
    case "merge":
      return applyMerge(blocks, op, anchorTypes, textBearingTypes);
    case "indent":
      return foldIndent(blocks, op.blockIds).next;
    case "outdent":
      return foldOutdent(blocks, op.blockIds, anchorOf(anchorTypes)).next;
    case "insert":
      return applyInsert(blocks, op);
    case "delete":
      return applyDelete(blocks, op);
    case "unwrap":
      return applyUnwrap(blocks, op);
    case "move":
      return applyMove(blocks, op);
    case "bulkMove":
      return applyBulkMoveOp(blocks, op);
    case "paste":
      return applyPaste(blocks, op);
    case "duplicate":
      return applyDuplicate(blocks, op);
    case "splice":
      return planSplice(blocks, op, ctx)?.blocks ?? blocks;
    case "deleteSpan":
      return applyDeleteSpan(blocks, op, anchorTypes, textBearingTypes);
  }
}

/**
 * Drop every container anchor the forest left childless. An anchor's content IS
 * its children, so a childless one is an empty box the user cannot have meant to
 * keep — the last child leaving (outdent, move, merge, delete) is what dissolves
 * the container.
 *
 * A POST-PASS derived from the CURRENT forest at application time, never a flag
 * minted at intent time — the same argument `applySplit`'s adoption comment
 * makes: ops apply against the current forest (the optimistic overlay replays
 * onto a refreshed base, and the server applies against its own load), so a
 * decision frozen when the keystroke fired could contradict the forest by the
 * time the op actually applies. Deriving keeps it true at the moment of
 * application, byte-identical on client and server.
 *
 * Iterated to a fixed point because anchors nest: an anchor whose only child was
 * an anchor is itself empty once that one goes.
 *
 * A `PAGE_BLOCK_TYPE` row is NEVER pruned, whatever `anchorTypes` says — an
 * empty page is legitimate content, and deleting one here would FK-cascade a
 * whole sub-page away from a keystroke. That is the catastrophic false positive,
 * so it is guarded explicitly and pinned by test.
 *
 * Known gap, deliberate: an `insert` op naming an anchor type mints a childless
 * anchor that this pass immediately removes. Anchors are never born that way —
 * the wrap mints the anchor and its first child in ONE patch (not an op). There
 * is no longer any op-shaped path that escapes this pass: `paste`, `duplicate`,
 * the bulk `delete` set and `bulkMove` all flow through `applyBlockOp` on both
 * sides, so an anchor a bulk gesture empties is pruned identically here and on
 * the server. Only the blind `BlockPatch` writer (undo/redo) can still land a
 * childless anchor, and there the surface's one-line childless fallback makes it
 * visible and deletable rather than a ghost.
 */
function pruneEmptyAnchors(
  blocks: BlockNode[],
  anchorTypes: ReadonlySet<string>,
): BlockNode[] {
  if (anchorTypes.size === 0) return blocks; // identity: today's behavior
  let next = blocks;
  for (;;) {
    const parents = new Set(next.map((b) => b.parentId));
    const doomed = next
      .filter(
        (b) =>
          anchorTypes.has(b.type) &&
          b.type !== PAGE_BLOCK_TYPE &&
          !parents.has(b.id),
      )
      .map((b) => b.id);
    if (doomed.length === 0) return next;
    next = remove(next, doomed);
  }
}

function applySplit(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "split" }>,
  anchorTypes: ReadonlySet<string>,
): BlockNode[] {
  const isAnchor = anchorOf(anchorTypes);
  const origin = byId(blocks, op.blockId);
  if (!origin) return blocks;
  // A page row owns no text, so there is nothing to split, and `asChild` would
  // seed the new node into the sub-page's own `page_id` partition without ever
  // stamping it. Structurally unreachable (the renderer registers no text
  // surface, so Enter can't originate here) — the guard is the belt.
  if (origin.type === PAGE_BLOCK_TYPE) return blocks;
  // Same belt, same argument, for a container anchor: it renders no line, hosts
  // no text surface and registers no focus handle, so Enter cannot originate in
  // one. A split there would write `data.text` onto a void schema (400 at the
  // write boundary) and mint a second empty container.
  if (anchorTypes.has(origin.type)) return blocks;

  // Content lands where it can be seen. Splitting ON the borrowed line of a
  // COLLAPSED container would put the tail among the children R2 hides — no row,
  // no Lexical instance — while the executor has already truncated the origin's
  // live doc and queued focus at the new id, so the text after the caret would
  // simply vanish. Open the box first and the split then means exactly what it
  // means anywhere else. `applyInsert`/`applyPaste`/`applyMove` have always
  // opened their destination parent; this was the one op that did not.
  //
  // Done before anything else is read, so the adoption gate below sees the forest
  // the user will actually be looking at — identical to expanding the container
  // by hand and then pressing Enter. Refusals come FIRST so a refused split stays
  // an exact identity no-op (`dispatchOp` drops empty diffs).
  const revealed = revealAround(blocks, origin, isAnchor);
  const block = byId(revealed, op.blockId) ?? origin;

  // Live callers pass authoritative `op.runs`; the `runsOfNode` fallback (lagged
  // `data.text` projection) is the pure reducer's basis (tests / non-live).
  const runs = op.runs ?? runsOfNode(block);
  const [beforeRuns, afterRuns] = splitRuns(runs, op.position);

  // Enter at the START of a NON-EMPTY block: preserve the origin's identity.
  // Insert a NEW EMPTY sibling immediately ABOVE and leave the origin completely
  // untouched (id, full text, children subtree, content doc, expanded, data). The
  // caret stays in the origin at offset 0 (the executor's job). Notion's model —
  // and it keeps the text's block id stable, so block-id-keyed state never churns.
  // `afterRuns.length > 0` isolates this from EMPTY-block Enter (position 0 but
  // nothing after the caret), which must keep spawning a plain empty sibling BELOW
  // with the caret moving down. asChild and mid/end splits are unaffected.
  if (!op.asChild && op.position === 0 && afterRuns.length > 0) {
    const prev = prevSibling(revealed, block);
    const aboveRank = Rank.between(
      prev ? Rank.from(prev.rank) : null,
      Rank.from(block.rank),
    );
    const aboveNode: BlockNode = {
      id: op.newId,
      pageId: block.pageId,
      parentId: block.parentId,
      // The intent layer withholds `splitInto` for this split precisely because
      // the row it mints is the HEAD, not the tail (see `resolveKeystroke`), so
      // `siblingType` is never set here — read for belt-and-braces only.
      type: op.siblingType ?? block.type,
      data: {
        ...asObject(op.tailData !== undefined ? op.tailData : block.data),
        text: [],
      },
      rank: aboveRank.toJSON(),
      expanded: true,
    };
    return add(revealed, aboveNode); // origin's object reference returned untouched
  }

  const updatedBlock = op.asChild
    ? // Nesting the tail as the first child forces the original open, so the
      // new child is visible.
      { ...withRuns(block, beforeRuns), expanded: true }
    : withRuns(block, beforeRuns);
  const newType = (op.asChild ? op.childType : op.siblingType) ?? block.type;
  const slot = splitSlot(revealed, block, op.asChild ?? false, isAnchor);

  let next = replace(revealed, updatedBlock);
  const newNode: BlockNode = {
    id: op.newId,
    pageId: block.pageId,
    parentId: slot.parentId,
    type: newType,
    data: mintedTailData(block, newType, op.tailData, afterRuns),
    rank: Rank.between(slot.prev, slot.next).toJSON(),
    // A block is BORN EXPANDED. The tail is either childless (where the flag is
    // unobservable) or has just adopted the origin's visible children (which it
    // must show). Minting `true` everywhere is what makes "a collapsed row is
    // the user's own act" a fact rather than a hope — the flag used to be inert
    // for containers precisely because creation minted `false`.
    expanded: true,
  };
  next = add(next, newNode);
  return adoptInto(next, slot.adopted, op.newId);
}

/**
 * WHERE a split puts the line it mints, and which of the origin's children go
 * with it. The one placement rule, shared by `split` and `splice` — a splice is
 * a split with a forest between the two halves, so a divergence here would make
 * pasting "a⏎b" mid-line land its lines somewhere Enter never would.
 *
 *  - `asChild` — nest as the origin's FIRST child, ahead of any existing child.
 *    Nothing is adopted: the new line already sits right under the origin.
 *  - otherwise — the origin's next sibling, and the new line ADOPTS the origin's
 *    VISIBLE children. That is the visible-line invariant: a split turns one
 *    visible line into two ADJACENT visible lines — the tail is the
 *    immediately-next visible line, and no other line changes position or
 *    depth. A plain sibling insert satisfies that only when the origin has no
 *    visible children; otherwise the tail would render AFTER the whole subtree.
 *    So the tail adopts them all: each child is reparented keeping its rank
 *    string byte-for-byte (the whole sibling set moves together, so
 *    uniqueness/order carry). Collapsed children are not visible lines, so they
 *    stay with the head. "Visible" is `visibleChildrenOf`, not the raw
 *    `expanded` flag, so the rule reads the same forest the user sees —
 *    including inside a container, where `revealAround` has already opened the
 *    box the caret was standing in.
 *
 * Adoption is DERIVED from the current forest inside the reducer, not carried
 * on the op, because ops apply against the CURRENT forest — overlay replays onto
 * a refreshed base, and the server applies against its own load — so a flag
 * frozen at intent time could contradict the forest at application time (e.g. a
 * racing collapse). It is the exact mirror of `applyMerge`'s adoption: after a
 * split the head is childless, so `prevVisibleLine(tail)` resolves to the head
 * and a following merge re-adopts — which is what makes split∘merge round-trip.
 *
 * Returns the rank WINDOW rather than a rank, so a caller landing N lines there
 * (`Rank.nBetween`) and one landing one (`Rank.between`) share it.
 */
function splitSlot(
  blocks: BlockNode[],
  block: BlockNode,
  asChild: boolean,
  isAnchor: IsAnchor,
): {
  parentId: string | null;
  prev: Rank | null;
  next: Rank | null;
  adopted: BlockNode[];
} {
  if (asChild) {
    const firstChild = childrenOf(blocks, block.id)[0] ?? null;
    return {
      parentId: block.id,
      prev: null,
      next: firstChild ? Rank.from(firstChild.rank) : null,
      adopted: [],
    };
  }
  const following = nextSibling(blocks, block);
  return {
    parentId: block.parentId,
    prev: Rank.from(block.rank),
    next: following ? Rank.from(following.rank) : null,
    adopted: visibleChildrenOf(blocks, block, isAnchor),
  };
}

/** Reparent `adopted` under `newParentId`, rank strings preserved. */
function adoptInto(
  blocks: BlockNode[],
  adopted: readonly BlockNode[],
  newParentId: string,
): BlockNode[] {
  let next = blocks;
  for (const child of adopted) {
    next = replace(next, { ...child, parentId: newParentId });
  }
  return next;
}

/**
 * The `data` of a tail line a split (or a splice) mints: `tailData` when the
 * intent layer resolved one (e.g. a checked to-do → unchecked tail), else the
 * origin's data — but ONLY when the tail is the SAME type. `data` belongs to a
 * type: carrying a callout's `{icon, color}` onto a `text` tail
 * hands the write boundary a payload its strict schema rejects outright (400
 * `Unrecognized key(s)`), which is exactly what a container's
 * `splitChildWhenExpanded: {childType: "text"}` produces on every Enter. A
 * cross-type tail therefore starts from `{}` and lets the target schema's own
 * defaults fill it in. This stayed latent until a block type carried more than
 * `{text}`: every earlier cross-type split (heading → text, list → text)
 * happened to be between structurally identical schemas. `text` is `runs`
 * regardless.
 */
function mintedTailData(
  origin: BlockNode,
  tailType: string,
  tailData: unknown,
  runs: RichText,
): Record<string, unknown> {
  const base =
    tailData !== undefined
      ? tailData
      : tailType === origin.type
        ? origin.data
        : {};
  return { ...asObject(base), text: runs };
}

/** Where the caret lands after a splice: the end of the pasted content. */
export interface SpliceCaret {
  blockId: string;
  /** Linear offset in that block's text. */
  offset: number;
}

/**
 * The `splice` op, planned: the forest it produces and where the caret lands.
 * `null` is a REFUSAL — the op is then the identity, so `dispatchOp` drops it
 * before the network like any refused op.
 *
 * > A forest pasted or dropped at an insertion point inside a block's text is
 * > SPLICED there: the text before the point keeps its line and absorbs the
 * > forest's leading paragraph; the text after the point goes to the end of the
 * > forest's last paragraph; everything else lands in between.
 *
 * Step by step, `[before, after] = splitRuns(op.runs, op.position)`:
 *
 *  1. **Head.** A leading plain paragraph (the `defaultTextType` — nothing
 *     else has an inline form) merges into the origin: its text becomes
 *     `before + head`, and it leaves the forest. Lines nested under it become
 *     the origin's first children, so a partial copy's nesting survives.
 *  2. **Text only.** Nothing left: the origin reads `before + head + after` and
 *     that is the whole op — a single-paragraph paste is a text edit.
 *  3. **Consume an empty origin.** Textless (empty `before`, no head merged), of
 *     the default-text type and childless: the forest takes its slot instead of
 *     landing below an empty line — `# Title⏎body` pasted into an empty line
 *     leaves no blank line above the title.
 *  4. **Body.** The rest lands where a split would put its tail
 *     (`splitSlot`): as the origin's next siblings, or — at the END of a line
 *     with visible children, where Enter nests — as its first children.
 *  5. **Tail.** A non-empty `after` goes to the end of the forest's LAST LINE
 *     (its last root's deepest last descendant, or the merged head's) when that
 *     line is a plain paragraph, at whatever depth — so a multi-line partial
 *     copy pasted mid-line joins at BOTH ends (`zz|zz` + `aa` › `bb` gives
 *     `zzaa` › `bbzz`). Else it goes onto a tail line `op.tailId` of split's
 *     type and data (`siblingType` / `tailData`). The root holding it adopts the
 *     origin's visible children after its own, as split's tail does, so the
 *     text after the point keeps the lines that followed it.
 *
 * Refusals are split's (no origin, a page row, an anchor, a text-less row) —
 * and paste's missing anchor is the first of them, since the origin IS the
 * anchor.
 */
export function planSplice(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "splice" }>,
  ctx: BlockOpContext = {},
): { blocks: BlockNode[]; caret: SpliceCaret } | null {
  const anchorTypes = ctx.anchorTypes ?? NO_ANCHORS;
  const isAnchor = anchorOf(anchorTypes);
  const origin = byId(blocks, op.blockId);
  if (!origin) return null;
  // Split's refusals, for split's reasons: a page row and a container anchor own
  // no text, so there is no insertion point in them. A text-less row (divider,
  // image) has none either — and writing `data.text` onto it is a 400 at the
  // write boundary. `textBearingTypes` absent is "no opinion", as for merge.
  if (origin.type === PAGE_BLOCK_TYPE || anchorTypes.has(origin.type))
    return null;
  if (ctx.textBearingTypes && !ctx.textBearingTypes.has(origin.type))
    return null;
  if (op.forest.length === 0) return null;

  // Content lands where it can be seen — split's `revealAround`, for split's
  // reason: a paste on a collapsed container's borrowed line would otherwise
  // land its lines among the children the fold hides.
  const revealed = revealAround(blocks, origin, isAnchor);
  const block = byId(revealed, op.blockId) ?? origin;
  if (op.granularity === "blocks")
    return planWholeLines(revealed, block, op, ctx);
  const [before, after] = splitRuns(op.runs, op.position);

  const isPlain = (node: IdentifiedBlock | undefined): boolean =>
    node !== undefined &&
    ctx.defaultTextType !== undefined &&
    node.type === ctx.defaultTextType;

  // 1. Head. The forest's first LINE joins the caret's line when it has an
  // inline form (a plain paragraph) — whatever hangs under it: a partial copy
  // whose first line had nested lines below it keeps them, nested under the
  // line it joined (`headChildren`).
  const [first, ...others] = op.forest;
  const headMerged = isPlain(first);
  const headChildren = headMerged ? first!.children : [];
  const rest = headMerged ? others : op.forest;
  const headLine = headMerged ? mergeRuns(before, runsOfNode(first!)) : before;

  // 2. Text only.
  if (rest.length === 0 && headChildren.length === 0) {
    return {
      blocks: replace(revealed, withRuns(block, mergeRuns(headLine, after))),
      caret: { blockId: block.id, offset: runsLength(headLine) },
    };
  }

  // 3. Consume an empty origin.
  const consumed =
    !headMerged &&
    runsLength(before) === 0 &&
    ctx.defaultTextType !== undefined &&
    block.type === ctx.defaultTextType &&
    childrenOf(revealed, block.id).length === 0;

  // 4. Body — split's slot. At the end of a line whose children are visible,
  // Enter nests (the intent layer's `asChild`), and so does the forest: landing
  // it as next siblings would put it after the whole subtree, below lines the
  // user sees directly under the caret. With text after the point the forest is
  // a sibling run and the line holding that text adopts the children instead.
  const atEnd = runsLength(after) === 0;
  const asChild =
    atEnd && visibleChildrenOf(revealed, block, isAnchor).length > 0;
  const slot = splitSlot(revealed, block, asChild, isAnchor);

  // 5. Tail. The forest's LAST LINE — its last root's deepest last descendant,
  // or the merged head's when no root follows it — takes the text after the
  // point when it is a plain paragraph (a last line has no children), whatever
  // its depth: so a partial copy pasted mid-line joins at BOTH ends, its
  // middle lines keeping their relative nesting. Else a tail line is minted
  // after the roots, of split's type and data.
  const lastRoot = rest[rest.length - 1];
  const end = lastLineOf(lastRoot ?? first!);
  let roots: IdentifiedBlock[] = rest;
  let caret: SpliceCaret;
  // The ROOT whose subtree now ends with the text after the point: the origin's
  // visible children (the lines that followed the caret's line) move under it,
  // after its own children, exactly as split's tail adopts them. Null when the
  // last line sits under the ORIGIN (a merged head with no roots after it): the
  // origin's own children already follow it there.
  let holderId: string | null = lastRoot?.id ?? null;
  let headKids = headChildren;
  if (atEnd) {
    caret = { blockId: end.id, offset: runsLength(runsOfNode(end)) };
  } else if (isPlain(end)) {
    const endRuns = runsOfNode(end);
    const joined = mergeRuns(endRuns, after);
    roots = withLineText(rest, end.id, joined);
    // The merged head's own nested lines hold the last line when no root
    // follows the head.
    headKids = withLineText(headChildren, end.id, joined);
    caret = { blockId: end.id, offset: runsLength(endRuns) };
  } else {
    const tailType = op.siblingType ?? block.type;
    roots = [
      ...rest,
      {
        id: op.tailId,
        type: tailType,
        data: mintedTailData(block, tailType, op.tailData, after),
        expanded: true,
        children: [],
      },
    ];
    holderId = op.tailId;
    caret = { blockId: op.tailId, offset: 0 };
  }
  let next = consumed
    ? remove(revealed, [block.id])
    : replace(revealed, {
        ...withRuns(block, headLine),
        expanded: asChild || headKids.length > 0 ? true : block.expanded,
      });
  // A merged head's children become the origin's FIRST children — the lines
  // right below the line they hung under. In the nesting slot they share it
  // with the roots (one rank window, head children first).
  const firstChild = childrenOf(revealed, block.id)[0] ?? null;
  if (headKids.length > 0 && !asChild) {
    next = [
      ...next,
      ...planForestInsert({
        pageId: block.pageId,
        parentId: block.id,
        rootRanks: Rank.nBetween(
          null,
          firstChild ? Rank.from(firstChild.rank) : null,
          headKids.length,
        ),
        forest: headKids,
      }).nodes,
    ];
  }
  const slotted = asChild ? [...headKids, ...roots] : roots;
  if (slotted.length > 0) {
    next = [
      ...next,
      ...planForestInsert({
        pageId: block.pageId,
        parentId: slot.parentId,
        rootRanks: Rank.nBetween(slot.prev, slot.next, slotted.length),
        forest: slotted,
      }).nodes,
    ];
  }
  // `adopted` is non-empty only off the `asChild` arm with visible children,
  // i.e. with text after the point.
  if (holderId !== null && !atEnd)
    next = adoptAfterChildren(next, slot.adopted, holderId);
  return { blocks: next, caret };
}

/**
 * `forest` with the line `lineId` (anywhere in it) re-texted to `runs` — and,
 * since it may adopt the origin's children, shown expanded.
 */
function withLineText(
  forest: IdentifiedBlock[],
  lineId: string,
  runs: RichText,
): IdentifiedBlock[] {
  return forest.map((node) =>
    node.id === lineId
      ? {
          ...node,
          data: { ...asObject(node.data), text: runs },
          expanded: true,
        }
      : { ...node, children: withLineText(node.children, lineId, runs) },
  );
}

/**
 * Reparent `adopted` under `holderId`, AFTER its existing children. A holder
 * with no children of its own keeps their rank strings byte-for-byte (split's
 * `adoptInto`); one with children gets fresh ranks past its last child, since
 * the two sibling sets' ranks were never comparable.
 */
function adoptAfterChildren(
  blocks: BlockNode[],
  adopted: readonly BlockNode[],
  holderId: string,
): BlockNode[] {
  if (adopted.length === 0) return blocks;
  const own = childrenOf(blocks, holderId);
  if (own.length === 0) return adoptInto(blocks, adopted, holderId);
  const ranks = Rank.nBetween(
    Rank.from(own[own.length - 1]!.rank),
    null,
    adopted.length,
  );
  let next = blocks;
  adopted.forEach((child, i) => {
    next = replace(next, {
      ...child,
      parentId: holderId,
      rank: ranks[i]!.toJSON(),
    });
  });
  return next;
}

/**
 * `splice` for a `"blocks"` forest: whole lines, landed where `paste` lands a
 * forest — `insertForestAt` after the origin, so after its whole subtree —
 * with no head and no tail merge. The origin keeps its text (`op.runs`, i.e.
 * minus a selected range, which the paste replaces), and an origin left EMPTY,
 * plain and childless is consumed exactly as a text splice consumes it: pasting
 * copied blocks into an empty line replaces the line.
 *
 * So there are two placement rules and each belongs to one granularity: text
 * lands where a SPLIT puts its tail (`splitSlot` — the text after the point
 * travels with it), whole blocks land where a PASTE puts a forest
 * (`insertForestAt` — nothing is split, so nothing needs the adjacency).
 */
function planWholeLines(
  revealed: BlockNode[],
  block: BlockNode,
  op: Extract<BlockOp, { kind: "splice" }>,
  ctx: BlockOpContext,
): { blocks: BlockNode[]; caret: SpliceCaret } {
  const consumed =
    runsLength(op.runs) === 0 &&
    ctx.defaultTextType !== undefined &&
    block.type === ctx.defaultTextType &&
    childrenOf(revealed, block.id).length === 0;
  const kept = replace(revealed, withRuns(block, op.runs));
  const landed = insertForestAt(kept, {
    forest: op.forest,
    afterId: block.id,
  });
  const end = lastLineOf(op.forest[op.forest.length - 1]!);
  return {
    blocks: consumed ? remove(landed, [block.id]) : landed,
    caret: { blockId: end.id, offset: runsLength(runsOfNode(end)) },
  };
}

/** The last line of a forest node in document order: its deepest last descendant. */
function lastLineOf(node: IdentifiedBlock): IdentifiedBlock {
  let cur = node;
  while (cur.children.length > 0) cur = cur.children[cur.children.length - 1]!;
  return cur;
}

function applyMerge(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "merge" }>,
  anchorTypes: ReadonlySet<string>,
  textBearingTypes: ReadonlySet<string> | undefined,
): BlockNode[] {
  const block = byId(blocks, op.blockId);
  if (!block) return blocks;
  // A page row carries no text to merge away, and merging DELETES the merged
  // block — which would take the whole sub-page (and its FK-cascaded content)
  // with it, from a keystroke.
  if (block.type === PAGE_BLOCK_TYPE) return blocks;
  // A container anchor carries no text either, and merging it away would delete
  // the container out from under its children. Escaping a container is `unwrap`.
  if (anchorTypes.has(block.type)) return blocks;

  // Merge into the previous VISIBLE line (the deepest last expanded descendant
  // of the prev sibling, or the parent when the block is a first child), not the
  // immediate sibling — so the caret lands where the text visually joins,
  // matching document order.
  const prev = prevVisibleLine(blocks, block, anchorOf(anchorTypes));
  if (!prev) return blocks; // no-op
  // Merging into a page row would write a `data.text` onto a `PageDataSchema`
  // payload AND adopt this block's children across the page boundary (under a
  // row whose subtree lives in another `page_id` partition). Neither is
  // representable — refuse.
  if (prev.type === PAGE_BLOCK_TYPE) return blocks;
  // Merging INTO a container anchor would write `data.text` onto a void schema
  // (400 at the write boundary) and adopt this block's children under a row that
  // renders no line — i.e. dissolve the box from one keypress. This is the live
  // hazard the two guards above are only the belt for: `nextVisibleLine` happily
  // returns an anchor, so Delete at the end of the line ABOVE a container
  // resolves here. Refusing demotes it to a plain caret move.
  if (anchorTypes.has(prev.type)) return blocks;
  // The rest of the void types (divider, image, embed, place, …). The guard
  // above covers only the CONTAINER half of "carries no text", and the reason it
  // gives — writing `data.text` onto a void schema is a 400 at the write
  // boundary — is exactly as true for a divider, which is not an anchor. Only a
  // client-side intent gate (`keystroke-intent.ts`) kept this unreachable, and
  // that gate's own comment records the 400 shipping once already; the reducer
  // is where client and server can agree, so the refusal belongs here too.
  // Presence-gated: see `BlockOpContext.textBearingTypes` on why an absent set
  // means "no opinion" rather than "refuse everything".
  if (textBearingTypes && !textBearingTypes.has(prev.type)) return blocks;

  // Concatenate runs into prev (coalescing the seam). `op.runs` is the live
  // merging runs on the live path; `runsOfNode` (lagged projection) is only the
  // pure reducer's fallback basis (tests / non-live).
  return mergeInto(
    blocks,
    block,
    prev,
    mergeRuns(runsOfNode(prev), op.runs ?? runsOfNode(block)),
  );
}

/**
 * Fold `block` into `prev`, the line directly above it: `prev` takes `runs`
 * (the joined text) and adopts `block`'s children, and `block` is removed.
 * THE merge rule, shared by `merge` and `deleteSpan`'s final step, so the two
 * gestures that join two lines cannot place adopted children differently.
 * Refusals are the caller's — this assumes `prev` can hold text.
 */
function mergeInto(
  blocks: BlockNode[],
  block: BlockNode,
  prev: BlockNode,
  runs: RichText,
): BlockNode[] {
  let mergedPrev = withRuns(prev, runs);

  // Adopt the block's children under prev, order-preserving. The general rule is
  // that adopted children occupy the visible position the merged block occupied:
  //  - `prev` is the merged block's own PARENT (the upward `prevVisibleLine`
  //    case, so `block` is prev's FIRST child) → the children take `block`'s slot,
  //    BEFORE `block`'s former next siblings.
  //  - otherwise `prev` is a previous sibling's deepest leaf, and nothing of
  //    `prev`'s follows → append after prev's existing children (today's rule).
  //
  // In the `intoParent` case the lower bound is `block`'s OWN rank, not `null`.
  // `block` is being deleted, so its slot `(block.rank, nextSibling)` is vacated
  // and the adopted children land in it — visually first, since `block` was the
  // first child. (It once also kept the server off a TRANSIENT unique violation,
  // when its write placed the children while `block` was still live; the writer
  // now trashes `block` first and parks every mover, so that no longer rests on
  // this window.)
  const adopted = childrenOf(blocks, block.id);
  const intoParent = prev.id === block.parentId;
  const existingPrevKids = childrenOf(blocks, prev.id);
  const lastPrevKid = lastOf(existingPrevKids);
  const nextAfterBlock = nextSibling(blocks, block);
  const adoptedRanks = intoParent
    ? Rank.nBetween(
        Rank.from(block.rank),
        nextAfterBlock ? Rank.from(nextAfterBlock.rank) : null,
        adopted.length,
      )
    : Rank.nBetween(
        lastPrevKid ? Rank.from(lastPrevKid.rank) : null,
        null,
        adopted.length,
      );
  if (adopted.length > 0) {
    mergedPrev = { ...mergedPrev, expanded: true };
  }

  let next = replace(blocks, mergedPrev);
  adopted.forEach((child, i) => {
    next = replace(next, {
      ...child,
      parentId: prev.id,
      rank: adoptedRanks[i]!.toJSON(),
    });
  });

  return remove(next, [block.id]);
}

/**
 * Delete the text span from inside `targetId` (A) to inside `sourceId` (C) —
 * see the op's doc. Derived entirely from the forest it is applied to, so both
 * runtimes reach the same rows from the same op:
 *
 * 1. **The lines strictly between A and C** are the visible lines
 *    `nextVisibleLine` walks from A before reaching C. Each is trashed with its
 *    subtree (a selected block carries its children) — EXCEPT C's ancestors.
 *    Those are fully covered too, but deleting one would delete C, so a plain
 *    ancestor is UNWRAPPED (`applyUnwrap`): its own line goes, its remaining
 *    children (C's branch and whatever follows it, uncovered) are lifted into
 *    its slot. No line the span did not cover is ever destroyed — a non-ancestor
 *    between A and C has every visible descendant between A and C too.
 *    A container ANCHOR ancestor is kept: it renders no line of its own, so the
 *    span covered only its first lines, not the box. The empty-anchor prune
 *    removes it if C was the last thing in it.
 * 2. **C is merged into A** with merge's rule (`mergeInto`): A keeps its id and
 *    takes `op.runs`, C's children take C's place, C is trashed. When C still
 *    sits in a kept anchor, "C's place" is inside that box (C is unwrapped
 *    there) — appending them under A would move them out of the box, past its
 *    remaining lines.
 * 3. **Refusals** are merge's, on both ends: neither may be a page row, a
 *    container anchor or a text-less type, and C must come after A. The client
 *    never issues a refused one (`normalizeSpan` widens such a span to
 *    blocks), so a refusal here means the forest moved under the op.
 */
function applyDeleteSpan(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "deleteSpan" }>,
  anchorTypes: ReadonlySet<string>,
  textBearingTypes: ReadonlySet<string> | undefined,
): BlockNode[] {
  const target = byId(blocks, op.targetId);
  const source = byId(blocks, op.sourceId);
  if (!target || !source || target.id === source.id) return blocks;
  const mergeable = (n: BlockNode): boolean =>
    n.type !== PAGE_BLOCK_TYPE &&
    !anchorTypes.has(n.type) &&
    // Presence-gated, as in `applyMerge`.
    (!textBearingTypes || textBearingTypes.has(n.type));
  if (!mergeable(target) || !mergeable(source)) return blocks;

  const isAnchor = anchorOf(anchorTypes);
  const between: BlockNode[] = [];
  let cur = nextVisibleLine(blocks, target, isAnchor);
  while (cur && cur.id !== source.id) {
    between.push(cur);
    cur = nextVisibleLine(blocks, cur, isAnchor);
  }
  // C is not below A (or not visible at all): not a span this forest has.
  if (!cur) return blocks;

  const sourceAncestors = new Set<string>();
  for (let p = source.parentId; p !== null;) {
    sourceAncestors.add(p);
    p = byId(blocks, p)?.parentId ?? null;
  }
  const doomed = new Set(
    between
      .filter((n) => !sourceAncestors.has(n.id))
      .flatMap((n) => subtreeIds(blocks, n.id)),
  );
  let next = remove(blocks, doomed);
  // Innermost first (`between` is document order, so ancestors come outermost
  // first): each unwrap lifts what is left of one level into the level above.
  for (const n of [...between].reverse()) {
    if (sourceAncestors.has(n.id) && !anchorTypes.has(n.type))
      next = applyUnwrap(next, { kind: "unwrap", blockId: n.id });
  }

  const src = byId(next, source.id)!;
  const tgt = byId(next, target.id)!;
  const keptBox =
    src.parentId !== null &&
    src.parentId !== tgt.id &&
    between.some((n) => n.id === src.parentId);
  if (!keptBox) return mergeInto(next, src, tgt, op.runs);
  next = applyUnwrap(next, { kind: "unwrap", blockId: src.id });
  return replace(next, withRuns(tgt, op.runs));
}

/**
 * Nest ONE block under its previous sibling. Returns `null` when the move is not
 * available (no previous sibling, or the sibling is a page row).
 */
function indentOne(blocks: BlockNode[], blockId: string): BlockNode[] | null {
  const block = byId(blocks, blockId);
  if (!block) return null;
  const prev = prevSibling(blocks, block);
  if (!prev) return null;
  // Reparenting under a page row moves the block into that sub-page's subtree
  // while its `page_id` still names the outer page — a row reachable by no
  // page-scoped query. The reducer cannot restamp `page_id` (in-page
  // invariant), so Tab-into-a-page is simply not a move.
  if (prev.type === PAGE_BLOCK_TYPE) return null;

  const lastChild = lastOf(childrenOf(blocks, prev.id));
  const newRank = Rank.between(
    lastChild ? Rank.from(lastChild.rank) : null,
    null,
  );

  let next = replace(blocks, {
    ...block,
    parentId: prev.id,
    rank: newRank.toJSON(),
  });
  next = replace(next, { ...prev, expanded: true });
  return next;
}

/**
 * Lift ONE block out to its parent's level, adopting the siblings that followed
 * it as its own children (Notion's outdent: the visual subtree below the block
 * stays attached to it). Returns `null` when the move is not available (already
 * top level, or the parent is a page row — outdenting past it escapes the page).
 *
 * Out of a container ANCHOR the block adopts NOTHING: it lands right after the
 * box and the lines below it stay in the box. A container's children are the
 * box's content, not a subtree of the line above them — adopting them would
 * carry them out of the box under the escaping line, which paints as the box
 * cut in two around it. Every outdent path (empty-Enter, Shift+Tab, the bulk
 * selection outdent) goes through here, so none of them can split a container.
 */
function outdentOne(
  blocks: BlockNode[],
  blockId: string,
  isAnchor: IsAnchor,
): BlockNode[] | null {
  const block = byId(blocks, blockId);
  if (!block) return null;
  if (!block.parentId) return null; // already at top level

  const parent = byId(blocks, block.parentId);
  if (!parent) return null;
  if (parent.type === PAGE_BLOCK_TYPE) return null;

  // Capture followers + the block's existing children from the PRE-move array,
  // before mutating anything.
  const blockRank = Rank.from(block.rank);
  const followers = isAnchor(parent)
    ? []
    : childrenOf(blocks, parent.id).filter(
        (s) => Rank.compare(Rank.from(s.rank), blockRank) > 0,
      );
  const existingKids = childrenOf(blocks, block.id);

  // Block becomes the sibling immediately after `parent`, reparented to the
  // grandparent.
  const parentNext = nextSibling(blocks, parent);
  const newRank = Rank.between(
    Rank.from(parent.rank),
    parentNext ? Rank.from(parentNext.rank) : null,
  );
  let movedBlock: BlockNode = {
    ...block,
    parentId: parent.parentId,
    rank: newRank.toJSON(),
  };

  // Reparent the following siblings as children of `block`, appended after the
  // block's existing children, order-preserving.
  const lastExistingKid = lastOf(existingKids);
  const followerRanks = Rank.nBetween(
    lastExistingKid ? Rank.from(lastExistingKid.rank) : null,
    null,
    followers.length,
  );
  if (followers.length > 0) {
    movedBlock = { ...movedBlock, expanded: true };
  }

  let next = replace(blocks, movedBlock);
  followers.forEach((follower, i) => {
    next = replace(next, {
      ...follower,
      parentId: block.id,
      rank: followerRanks[i]!.toJSON(),
    });
  });

  return next;
}

/** The result of a bulk fold: the next forest and which blocks actually moved. */
type Fold = { next: BlockNode[]; moved: string[] };

/**
 * Indent a SET of blocks: fold `indentOne` over them in TOP-TO-BOTTOM document
 * order.
 *
 * The direction is what makes the set move as one rigid body. A successful
 * indent removes the mover from its sibling list, so the next selected sibling's
 * previous sibling becomes that same new parent — the run lands as consecutive
 * children of the block above it, preserving its internal shape.
 *
 * The `blockIds` guard is the other half: when a block cannot indent (it is the
 * first child), the selected sibling below it would otherwise nest *into* it and
 * silently reshape the selection. Refusing to nest under a selected block that
 * stayed put makes that skip cascade down the run — the whole run holds still,
 * which is what "indent these blocks" must mean.
 */
function foldIndent(blocks: BlockNode[], blockIds: readonly string[]): Fold {
  if (blockIds.length === 0) return { next: blocks, moved: [] };
  const selected = new Set(blockIds);
  const moved: string[] = [];
  let next = blocks;
  for (const id of inDocumentOrder(blocks, blockIds)) {
    const node = byId(next, id);
    if (!node) continue;
    const prev = prevSibling(next, node);
    // Still a sibling of a selected block ⇒ that block failed to indent.
    if (prev && selected.has(prev.id)) continue;
    const applied = indentOne(next, id);
    if (!applied) continue;
    next = applied;
    moved.push(id);
  }
  return { next, moved };
}

/**
 * Outdent a SET of blocks: fold `outdentOne` over them in BOTTOM-TO-TOP document
 * order — the mirror of `foldIndent`'s direction, for the mirror reason.
 *
 * `outdentOne` adopts the followers that remain below the block. Going bottom-up,
 * every selected follower has already left its parent by the time an earlier
 * block moves, so the selection's internal shape survives and only UNSELECTED
 * followers are adopted — by the last selected block, exactly as outdenting that
 * block alone would do. (Top-down, the first block would swallow the rest of the
 * selection as children.) Landing each mover directly after its parent then
 * stacks them back into their original relative order.
 */
function foldOutdent(
  blocks: BlockNode[],
  blockIds: readonly string[],
  isAnchor: IsAnchor,
): Fold {
  if (blockIds.length === 0) return { next: blocks, moved: [] };
  const moved: string[] = [];
  let next = blocks;
  for (const id of inDocumentOrder(blocks, blockIds).reverse()) {
    const applied = outdentOne(next, id, isAnchor);
    if (!applied) continue;
    next = applied;
    moved.push(id);
  }
  return { next, moved: moved.reverse() };
}

/** Would indenting `blockIds` move anything? Drives the selection bar's affordance. */
export function canIndent(
  blocks: BlockNode[],
  blockIds: readonly string[],
): boolean {
  return foldIndent(blocks, blockIds).moved.length > 0;
}

/** Would outdenting `blockIds` move anything? Drives the selection bar's affordance. */
export function canOutdent(
  blocks: BlockNode[],
  blockIds: readonly string[],
): boolean {
  // Anchor-blind on purpose: WHETHER a block moves never depends on what it
  // adopts, only on its parent — so the answer is the same with any anchor set.
  return foldOutdent(blocks, blockIds, () => false).moved.length > 0;
}

// ---------------------------------------------------------------------------
// Bulk move (the drag of a whole selection)
// ---------------------------------------------------------------------------

/** Where one selection root lands. Field-compatible with `parkRanks`' `RankPlacement`. */
export interface BulkMovePlacement {
  id: string;
  /** The parent the row sits under NOW — the scope `parkRanks` parks it in. */
  currentParentId: string | null;
  parentId: string | null;
  /** Stored string form, like every `BlockNode.rank`. */
  rank: string;
}

/** Why a bulk move was refused. Each maps 1:1 to a distinguishable server 4xx. */
export type BulkMoveRefusal =
  "empty-selection" | "into-selection" | "into-own-subtree";

export interface BulkMovePlan {
  /** In DOCUMENT order. Empty iff `refusal !== null`. */
  placements: BulkMovePlacement[];
  /** The selection roots, document-ordered (what each writer re-reads / notifies). */
  roots: string[];
  /** The destination parent to open, or null for a top-level drop. */
  expandParentId: string | null;
  refusal: BulkMoveRefusal | null;
}

function refusedBulkMove(refusal: BulkMoveRefusal): BulkMovePlan {
  return { placements: [], roots: [], expandParentId: null, refusal };
}

/**
 * Plan where a whole selection lands when it is dragged under `parentId`,
 * immediately after `afterId` (or at the start of that sibling list when
 * `afterId` is null). Pure: the ONE definition of bulk-move's rank/order algebra,
 * run verbatim by the server writer, the in-memory store, and the provider's undo
 * prediction — if the three disagreed, the recorded undo patch would be wrong.
 *
 * **All-or-nothing, which is why this is `plan*` and not `fold*`.** A `Fold` in
 * this file is a per-element fold with PARTIAL refusal (`foldIndent` skips a
 * blocked block and cascades), and its `moved` subset names a state the forest
 * really reaches. A bulk move has no correct partial answer — a destination
 * inside the moving selection is not "one root that cannot go", it invalidates
 * the whole gesture — so a `moved` subset here would imply a state that cannot
 * occur. `plan*` also matches `planForestInsert`, the structural twin.
 *
 * **Roots are ordered by `inDocumentOrder`, and that is load-bearing.**
 * `selectionRoots` preserves the order ids appear in the INPUT ARRAY, and the two
 * writers hold that array in different orders (the server's `loadPageBlocks` has
 * no `ORDER BY` at all — Postgres heap order, which `UPDATE`s rewrite; a client
 * holds a global rank sort, which is not document order either). Minting the rank
 * run against an arbitrary order silently scrambles the selection's internal
 * order on the way down, and makes the two sides disagree about which root got
 * which key. The folds sort for exactly this reason.
 *
 * **Guards return a `refusal`; they never throw and never silently no-op.** A
 * pure core helper cannot throw `HttpError` (wrong layer), and swallowing would
 * rob the server of the two distinguishable 400s it owes the user. Clients treat
 * any refusal as drop-before-record, the same discipline `dispatchOp` applies to
 * an empty reducer diff.
 *
 * @param destSiblings MUST be the COMPLETE live sibling set under `parentId` —
 * EVERY row with that `parent_id`, unfiltered by page and unfiltered by type. It
 * defaults to `blocks` because a client holds its page's forest whole, but the
 * server MUST pass `loadLiveSiblings(tx, parentId)`: a destination page row's
 * children are keyed to that page and are therefore absent from a page-scoped
 * load, so a window computed over page-scoped rows mints `"a0"` straight onto the
 * sub-page's existing first child. `page_blocks` has ONE `(parent_id, rank)`
 * ordering space that several live resources project disjointly — arithmetic over
 * a filtered projection mints keys that collide with the siblings it cannot see.
 */
export function planBulkMove(
  blocks: BlockNode[],
  args: {
    ids: readonly string[];
    parentId: string | null;
    afterId: string | null;
  },
  destSiblings: BlockNode[] = blocks,
): BulkMovePlan {
  const moving = new Set(args.ids);
  const roots = inDocumentOrder(blocks, selectionRoots(blocks, moving));
  if (roots.length === 0) return refusedBulkMove("empty-selection");

  // Cycle guard: the selection cannot land inside itself (nor onto itself).
  if (args.parentId !== null) {
    if (moving.has(args.parentId)) return refusedBulkMove("into-selection");
    for (const root of roots) {
      if (isDescendant(blocks, root, args.parentId)) {
        return refusedBulkMove("into-own-subtree");
      }
    }
  }

  // Exclude everything that is moving, so the moved roots don't bound their own
  // insertion window. (The excluded ids can therefore collide transiently with a
  // still-unmoved root's rank — which is what the server's park-then-place phase
  // exists to absorb; see `forest-writer.ts`.)
  const movingSubtree = new Set(roots.flatMap((r) => subtreeIds(blocks, r)));
  const [prev, next] = rankWindow(
    destSiblings,
    args.parentId,
    args.afterId,
    movingSubtree,
  );
  const ranks = Rank.nBetween(prev, next, roots.length);

  const placements = roots.map((id, i) => ({
    id,
    currentParentId: byId(blocks, id)!.parentId,
    parentId: args.parentId,
    rank: ranks[i]!.toJSON(),
  }));
  return { placements, roots, expandParentId: args.parentId, refusal: null };
}

/**
 * Apply a `planBulkMove` result to a forest: reparent + re-rank each placement
 * and open the destination, so a client's predicted after-state is byte-identical
 * to what the server's writer commits.
 *
 * Deliberately does NOT recompute `pageId` — the same in-page invariant
 * `applyMove` holds. The composite client store routes a cross-page selection
 * drop to the `moveBlocks` endpoint instead (and throws on a `bulkMove` that
 * would cross anyway), and the op endpoint refuses an out-of-page destination
 * loudly, so a `bulkMove` op never crosses a boundary.
 *
 * A refused plan is the identity — its `placements` are empty by construction.
 * Kept separate from `planBulkMove` because the plan carries the typed
 * `refusal` a caller may want to distinguish; `applyBulkMoveOp` is the reducer
 * arm that composes the two and reads a refusal as the identity.
 */
export function applyBulkMove(
  blocks: BlockNode[],
  plan: BulkMovePlan,
): BlockNode[] {
  let next = blocks;
  for (const p of plan.placements) {
    const node = byId(next, p.id);
    if (!node) continue;
    next = replace(next, { ...node, parentId: p.parentId, rank: p.rank });
  }
  if (plan.placements.length > 0 && plan.expandParentId) {
    const parent = byId(next, plan.expandParentId);
    if (parent && !parent.expanded)
      next = replace(next, { ...parent, expanded: true });
  }
  return next;
}

/**
 * The `bulkMove` reducer arm: plan, then apply. A refusal is the identity, so a
 * drag the forest cannot honour never reaches the undo stack, the overlay or the
 * network (`dispatchOp` drops an empty diff) — the same answer every other
 * refused op gives, rather than a distinguishable 4xx the bespoke endpoint used
 * to raise for a state the client's own guards already prevent.
 *
 * `planBulkMove`'s `destSiblings` defaults to `blocks`, which is exactly right
 * here: a `bulkMove` op's destination lies inside the op's own page (the
 * composite sends a cross-page selection drop to `moveBlocks`, the server
 * refuses an out-of-page destination), so the page-scoped forest IS the
 * complete sibling set on both sides.
 */
function applyBulkMoveOp(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "bulkMove" }>,
): BlockNode[] {
  const plan = planBulkMove(blocks, op);
  if (plan.refusal) return blocks;
  return applyBulkMove(blocks, plan);
}

/**
 * The denormalized nearest page ancestor of a would-be child of `parentId` —
 * the same rule as the server's `computePageId`, decided from the in-memory
 * forest. Shared by every insert path (`insert`, `paste`) so a new row's page
 * scope has exactly one definition.
 *
 * The reducer runs over a single page's *content* forest (`loadPageBlocks`
 * excludes the page row itself), so:
 *   - parent found, is a (sub-)page node → that page's id;
 *   - parent found, content block        → inherit its pageId;
 *   - parent NOT in the forest           → its id IS the page (a top-level
 *     insert is parented to the page row, which is excluded), so the new
 *     block's nearest page ancestor is `parentId`;
 *   - no parent at all (root insert)     → null.
 * Using `parent.pageId` unconditionally dropped a top-level block's pageId to
 * null (a page's own pageId is null), hiding it from the page-scoped query.
 */
function insertScopePageId(
  blocks: BlockNode[],
  parentId: string | null,
): string | null {
  const parent = parentId ? byId(blocks, parentId) : undefined;
  if (!parent) return parentId;
  return parent.type === PAGE_BLOCK_TYPE ? parent.id : parent.pageId;
}

/**
 * Insert ONE identified forest as a contiguous sibling run, after `afterId`
 * (inheriting its parent) or under `parentId`. The server's op handler runs
 * this same reducer arm — literally the same `planForestInsert` — so the
 * optimistic overlay and the persisted rows differ only in the ranks each side
 * minted against the sibling set it can see.
 *
 * The shared arm of `paste` (one call) and `duplicate` (one call per placement).
 * A missing anchor returns `blocks` unchanged; what that MEANS for the op is the
 * caller's to state — see `applyPaste` and `applyDuplicate`, which read the same
 * identity in deliberately different ways.
 */
function insertForestAt(
  blocks: BlockNode[],
  at: {
    forest: IdentifiedBlock[];
    afterId: string | null;
    parentId?: string | null;
  },
): BlockNode[] {
  if (at.forest.length === 0) return blocks;

  const after = at.afterId ? byId(blocks, at.afterId) : undefined;
  if (at.afterId && !after) return blocks;
  const parentId = after ? after.parentId : (at.parentId ?? null);

  const [prev, nextRank] = rankWindow(
    blocks,
    parentId,
    at.afterId,
    NO_EXCLUSIONS,
  );
  const { nodes } = planForestInsert({
    pageId: insertScopePageId(blocks, parentId),
    parentId,
    rootRanks: Rank.nBetween(prev, nextRank, at.forest.length),
    forest: at.forest,
  });

  // Open the destination parent (if it is a row we hold) so the inserted blocks
  // are visible — the same courtesy `applyInsert` does.
  let next = blocks;
  if (parentId) {
    const parent = byId(next, parentId);
    if (parent && !parent.expanded)
      next = replace(next, { ...parent, expanded: true });
  }
  return [...next, ...nodes];
}

/**
 * A missing anchor refuses the whole paste (returns `blocks` unchanged), exactly
 * as `applyInsert` refuses a missing `afterId`: the destination the user aimed
 * at is gone, and guessing another one would drop their content somewhere they
 * did not ask for. One forest, one anchor — so the arm's per-anchor identity IS
 * the whole-op refusal.
 */
function applyPaste(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "paste" }>,
): BlockNode[] {
  return insertForestAt(blocks, op);
}

/**
 * Duplicate a selection: fold each placement's clone in after its own source.
 *
 * **A dead anchor drops exactly its own placement, and that differs from paste
 * on purpose.** Paste refuses the *whole* op on a missing anchor because
 * guessing another parent would drop content the user never asked to place; a
 * duplicate placement names its destination explicitly and independently, so the
 * fold's natural per-placement identity (`insertForestAt` returns `blocks`
 * unchanged when `afterId` misses) is the right answer — the clone whose source
 * was raced away is dropped, the others land. All-or-nothing would be strictly
 * worse: the client's rows always contain every anchor (it built the op from
 * them), so a refusal can only ever fire server-side, where dropping N clones
 * instead of 1 just widens the never-confirming set.
 *
 * The fold is order-INDEPENDENT: a clone always lands strictly between its
 * source and the source's next sibling, so folding `[A, B]` and `[B, A]` for
 * adjacent siblings produces the same rows. The array's order is chosen for
 * determinism and a legible history, not for client/server agreement (the array
 * travels on the op and both sides fold it identically).
 */
function applyDuplicate(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "duplicate" }>,
): BlockNode[] {
  return op.placements.reduce(insertForestAt, blocks);
}

function applyInsert(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "insert" }>,
): BlockNode[] {
  let next = blocks;
  let newParentId: string | null;
  let newRank: Rank;
  let pageId: string | null;

  const afterId = op.afterId ?? null;
  const beforeId = op.beforeId ?? null;
  if (afterId) {
    const after = byId(blocks, afterId);
    if (!after) return blocks;
    const afterNext = nextSibling(blocks, after);
    newParentId = after.parentId;
    newRank = Rank.between(
      Rank.from(after.rank),
      afterNext ? Rank.from(afterNext.rank) : null,
    );
    pageId = after.pageId;
  } else if (beforeId) {
    const before = byId(blocks, beforeId);
    if (!before) return blocks;
    const beforePrev = prevSibling(blocks, before);
    newParentId = before.parentId;
    newRank = Rank.between(
      beforePrev ? Rank.from(beforePrev.rank) : null,
      Rank.from(before.rank),
    );
    pageId = before.pageId;
  } else {
    newParentId = op.parentId ?? null;
    const lastChild = lastOf(childrenOf(blocks, newParentId));
    newRank = Rank.between(lastChild ? Rank.from(lastChild.rank) : null, null);
    pageId = insertScopePageId(blocks, newParentId);
  }

  // Open the parent (if any) so the new block is visible.
  if (newParentId) {
    const parent = byId(next, newParentId);
    if (parent) next = replace(next, { ...parent, expanded: true });
  }

  const newNode: BlockNode = {
    id: op.newId,
    pageId,
    parentId: newParentId,
    type: op.type,
    data: op.data,
    rank: newRank.toJSON(),
    expanded: true,
  };
  return add(next, newNode);
}

/**
 * Delete each named block's whole subtree. Ids absent from the forest are
 * skipped rather than refusing the set: a bulk delete's roots are read off the
 * same rows the reducer folds over, so a missing one means another writer got
 * there first and the user's intent for the rest still holds. `subtreeIds`
 * answers `[id]` for a row it cannot find, hence the liveness filter first.
 */
function applyDelete(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "delete" }>,
): BlockNode[] {
  const live = op.blockIds.filter((id) => byId(blocks, id) !== undefined);
  if (live.length === 0) return blocks;
  const ids = new Set(live.flatMap((id) => subtreeIds(blocks, id)));
  return remove(blocks, ids);
}

/**
 * Dissolve a container: delete the block and promote its children into the slot
 * it occupied among its own former siblings, order preserved. Ids, types, `data`
 * and whole subtrees ride along untouched — only `parentId` and `rank` change.
 * A childless block is simply deleted.
 *
 * The rank window mirrors `applyMerge`'s `intoParent` adoption branch byte for
 * byte: the lower bound is the block's OWN rank, not its previous sibling's,
 * which lands the children in the same visual slot since the container is going
 * away. (A window of `(prevSibling, next)` can mint exactly the container's
 * rank — `nBetween("a0", "a2", 1)` is `"a1"` — which once collided on the
 * server, when its write placed the children while the container was still
 * live. The writer now trashes the container first, vacating its slot.)
 */
function applyUnwrap(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "unwrap" }>,
): BlockNode[] {
  const block = byId(blocks, op.blockId);
  if (!block) return blocks;
  // Unwrapping a page row would promote its content across the page boundary
  // (rows whose `parent_id` and `page_id` disagree) and delete the sub-page.
  if (block.type === PAGE_BLOCK_TYPE) return blocks;

  const promoted = childrenOf(blocks, block.id);
  const nextAfterBlock = nextSibling(blocks, block);
  const ranks = Rank.nBetween(
    Rank.from(block.rank),
    nextAfterBlock ? Rank.from(nextAfterBlock.rank) : null,
    promoted.length,
  );

  let next = blocks;
  promoted.forEach((child, i) => {
    next = replace(next, {
      ...child,
      parentId: block.parentId,
      rank: ranks[i]!.toJSON(),
    });
  });
  return remove(next, [block.id]);
}

/**
 * Move one block to the position `(parentId, targetId, zone)` names, minting the
 * rank here from the sibling set this forest holds — see `positionalRank` for
 * why the op carries intent rather than a key.
 */
function applyMove(
  blocks: BlockNode[],
  op: Extract<BlockOp, { kind: "move" }>,
): BlockNode[] {
  const block = byId(blocks, op.blockId);
  if (!block) return blocks;
  // Cycle guard: refuse to move a block under its own descendant (or itself).
  if (op.parentId !== null && isDescendant(blocks, op.blockId, op.parentId)) {
    return blocks;
  }
  // A stale anchor refuses the move outright, as `applyInsert` refuses a missing
  // `afterId`: the neighbour the user aimed at is gone or has since moved to
  // another parent, and resolving the intent against a different sibling list
  // would drop the block somewhere they never pointed at.
  if (op.targetId !== null) {
    const target = byId(blocks, op.targetId);
    if (!target || target.parentId !== op.parentId) return blocks;
  }
  const rank = positionalRank(
    blocks,
    op.parentId,
    op.targetId,
    op.zone,
    new Set([op.blockId]),
  );

  let next = replace(blocks, {
    ...block,
    parentId: op.parentId,
    rank: rank.toJSON(),
  });
  // Open the new parent (if any).
  if (op.parentId) {
    const parent = byId(next, op.parentId);
    if (parent) next = replace(next, { ...parent, expanded: true });
  }
  return next;
}
