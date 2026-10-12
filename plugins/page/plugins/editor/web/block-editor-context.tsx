import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import {
  newHistoryEntryId,
  usePendingFlush,
  useScopedUndoRedo,
} from "@plugins/primitives/plugins/undo-redo/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { resolveDropParent } from "@plugins/primitives/plugins/tree/core";
import {
  prevVisibleLine,
  nextVisibleLine,
  runsOfNode,
  runsLength,
  runsEqual,
  splitRuns,
  mergeRuns,
  blockSelectionRoots,
  childrenOf,
  diffBlocks,
  inDocumentOrder,
  patchesFromDiff,
  isEmptyPatch,
  withMintedIds,
  withPasteIds,
  pageSourcesOf,
  planSplice,
  newBlockId,
  namesField,
  hasTextKey,
  rowDataOf,
  joinAroundSpan,
  type Block,
  type BlockNode,
  type BlockOp,
  type BlockOpContext,
  type BlockPatch,
  type ForestGranularity,
  type IdentifiedBlock,
  type RichText,
  type RowData,
  type SerializedBlock,
  type SpanPoint,
} from "../core";
import {
  applyBlockRuns,
  spliceStoredBlockDoc,
} from "./internal/block-text-write-stored";
import type { BlockRunsEdit } from "./internal/block-run-tracker";
import {
  blockDocOwnerOf,
  closeAllOpenTextRuns,
  type BlockDocOwner,
} from "./internal/collab-session";
import { spliceOpenBlockDoc } from "./internal/block-text-write";
import type { ProjectTextFn } from "./internal/doc-sourced-runs";
import type { RowTruth } from "./internal/row-truth";
import {
  buildPatchOverlayOp,
  predictOp,
  toNodes,
} from "./internal/optimistic-block-ops";
import { serializeForest } from "./serialize-blocks";
import { claimCutPages, markCutsPasted } from "./internal/cut-claims";
import { landCaret, landCaretAtOwnEdge } from "./internal/caret-landing";
import { createCaretAuthority } from "./internal/caret-authority";
import type {
  BlockFocusHandle,
  BlockTextReads,
  FlightInput,
} from "./internal/caret-authority";
import type {
  CaretLandOptions,
  CaretSurface,
  CaretSurfaceRef,
} from "./caret-surface";
import { useBlockHandles, useBlockOpContext } from "./internal/block-handles";
import { scopeAdmits, scopeNodes } from "./internal/zoom-scope";
import {
  enterReplacingIntent,
  intentContextOf,
} from "./internal/keystroke-intent";
import {
  useMemoryBlockStore,
  type BelowFailure,
  type BlockStore,
  type SettledBlockStore,
} from "./block-store";
import { CompositeServerProviderHost } from "./composite-block-store";
import type { BlockEditorAPI } from "./types";

/** Human labels for the structural-undo history (tooltips / menus). */
const OP_LABELS: Record<BlockOp["kind"], string> = {
  insert: "Insert block",
  delete: "Delete blocks",
  split: "Split block",
  merge: "Merge blocks",
  indent: "Indent blocks",
  outdent: "Outdent blocks",
  unwrap: "Remove container",
  move: "Move block",
  bulkMove: "Move blocks",
  paste: "Paste blocks",
  duplicate: "Duplicate blocks",
  splice: "Paste",
  deleteSpan: "Delete text",
};

/**
 * The block id the user is "on" for an op, used to restore focus on undo/redo.
 * Takes the PRE-op rows because some ops focus a block they do not name.
 */
function opFocusId(
  op: BlockOp,
  before: Block[],
  ctx: BlockOpContext,
): string | null {
  switch (op.kind) {
    case "insert":
    case "split":
      return op.newId;
    case "merge":
    case "move":
      return op.blockId;
    case "unwrap":
      // The container VANISHES, so focusing `op.blockId` would land focus on a
      // row that no longer exists (i.e. on <body>). The caret belongs on the
      // first promoted child — the line the user was standing on when Backspace
      // dissolved the box, and the row that now occupies the container's slot.
      return childrenOf(toNodes(before), op.blockId)[0]?.id ?? null;
    case "indent":
    case "outdent":
    // A bulk delete names the whole selection; a single Backspace-delete names
    // exactly one block, and only then is there a caret to restore.
    case "delete":
      // A bulk indent/outdent/delete is driven from block-SELECTION mode, where
      // focus lives on the selection container, not in any block's editor.
      // Undo/redo then falls back to the patch's own first upsert.
      return op.blockIds.length === 1 ? (op.blockIds[0] ?? null) : null;
    case "bulkMove":
      // Same rule, same reason: a selection drag leaves focus on the container.
      return op.ids.length === 1 ? (op.ids[0] ?? null) : null;
    case "paste":
    // A duplicate is paste's shape exactly: clones land after their sources and
    // focus stays on the selection container. (Selecting the clones is a
    // deliberate non-goal — see the plan's follow-ups.)
    case "duplicate":
      // A paste never moves the caret — it lands blocks after the anchor and
      // leaves focus where it was (in the anchor block, or on the selection
      // container). There is no "block the user is on" to restore.
      return null;
    case "splice":
      // A splice DOES move the caret: to the end of what it pasted, which is
      // the line the reducer planned it onto (the origin, the forest's last
      // line, or the minted tail). A refused splice plans nothing and is never
      // recorded, so its null is never read.
      return planSplice(toNodes(before), op, ctx)?.caret.blockId ?? null;
    case "deleteSpan":
      // The join lives in the span's start line, which keeps its id.
      return op.targetId;
  }
}

/**
 * Pin a restored row's `data.text` to the DOC-EXACT runs captured at op time.
 *
 * `data.text` is a ~1 s-debounced projection of the block's content doc, so the
 * row snapshot an op diffs from can lag the doc by a whole typing run. The
 * reverse patch's `create` restores the row from that snapshot — and that text
 * is what history snapshots, search and backlinks read back, and what SEEDS the
 * block's doc when no stored doc survives the delete (a purged block, a block
 * whose doc-init never ran). So for every row the op removes (in `before`, not
 * in `after`) that has a live content owner, the create is pinned to what that
 * owner's doc holds NOW (`runsNow()`, a memo hit on the common path) — the very
 * value the projection would have written had it flushed. A row with no live
 * owner (never opened here) keeps its snapshot text.
 *
 * Only an AUTHORITATIVE doc pins (`BlockDocOwner.docAuthoritative`): an owner
 * whose transport has not answered yet holds an empty doc because nothing
 * ARRIVED, and pinning that would turn a not-known-yet into "this block is
 * empty" — the absorbable failure the rest of the text pipeline is built to
 * keep out of `data.text`.
 *
 * This generalises what merge once did by hand for its source row: every
 * removed row is pinned the same way, so a merged-away, deleted or unwrapped
 * block all come back carrying exactly what their doc held.
 *
 * The pin lands only where the reverse patch ALREADY writes `data`. A create
 * restores the whole row, so it always does; an update that says nothing about
 * `data` must keep saying nothing — pinning text there would turn a
 * field-scoped write back into an authority claim over a field it doesn't own.
 * (A removed row always comes back as a create, so the update arm is
 * unreachable today and kept only so the rule reads whole.)
 */
function pinRestoredText(
  undoPatch: BlockPatch,
  before: readonly Block[],
  after: readonly Block[],
): BlockPatch {
  const pins = new Map<string, RichText>();
  const afterIds = new Set(after.map((b) => b.id));
  for (const b of before) {
    if (afterIds.has(b.id) || !hasTextKey(b.data)) continue;
    const owner = blockDocOwnerOf(b.id);
    if (owner && owner.docAuthoritative) pins.set(b.id, owner.runsNow());
  }
  if (pins.size === 0) return undoPatch;
  const pin = (data: unknown, runs: RichText) => ({
    ...((data as Record<string, unknown> | null) ?? {}),
    text: runs,
  });
  return {
    ...undoPatch,
    creates: undoPatch.creates.map((b) => {
      const runs = pins.get(b.id);
      return runs ? { ...b, data: pin(b.data, runs) } : b;
    }),
    updates: undoPatch.updates.map((u) => {
      const runs = pins.get(u.id);
      return runs && namesField(u.changes, "data")
        ? { ...u, changes: { ...u.changes, data: pin(u.changes.data, runs) } }
        : u;
    }),
  };
}

/**
 * The structural half of {@link recordEntry}: diff the two full-row snapshots
 * into a minimal forward/reverse `BlockPatch` pair, pin every removed row's
 * `data.text` in the reverse patch to its doc's live runs
 * ({@link pinRestoredText}), and derive the per-direction focus targets.
 * Returns `null` when BOTH patches are empty; the recorder then bails unless
 * the entry carries `runsEdits` (a pure text entry). Redo keeps the `focusId`
 * the user was on; undo PREFERS the block the reverse patch restores over
 * `focusId` — undoing a split deletes the new block, so landing focus on it
 * would drop focus to <body>, whereas the reverse write's target is the
 * surviving block — falling back to `focusId` then the forward patch so every
 * op still lands somewhere sane.
 */
function derivePatchEntry(
  before: Block[],
  after: Block[],
  focusId: string | null,
): {
  undoPatch: BlockPatch;
  redoPatch: BlockPatch;
  undoFocus: string | null;
  redoFocus: string | null;
} | null {
  const patches = patchesFromDiff(diffBlocks(before, after));
  const redoPatch = patches.redo;
  const undoPatch = pinRestoredText(patches.undo, before, after);
  if (isEmptyPatch(undoPatch) && isEmptyPatch(redoPatch)) return null;
  // Order mirrors the patch's own precedence: redo's first write is its creates
  // (a split's new block), undo's is its updates (the surviving origin row).
  const redoFocus =
    focusId ?? redoPatch.creates[0]?.id ?? redoPatch.updates[0]?.id ?? null;
  const undoFocus =
    undoPatch.updates[0]?.id ?? undoPatch.creates[0]?.id ?? focusId ?? null;
  return { undoPatch, redoPatch, undoFocus, redoFocus };
}

/**
 * The live content owner of the block a splice cuts. A splice is only ever
 * issued from a MOUNTED text surface (the caret paste's editor, or the editor
 * under a drop's pointer), and a mounted surface holds its block's owner — so a
 * missing one is a broken assumption, never a case to route around: splicing
 * the row alone would leave the doc (the text's owner) holding the whole line
 * while the row says half of it.
 */
function spliceOwnerOf(blockId: string): BlockDocOwner {
  const owner = blockDocOwnerOf(blockId);
  if (!owner) {
    throw new Error(
      `splice: block "${blockId}" has no live content owner, so its text ` +
        "cannot be cut at the insertion point",
    );
  }
  return owner;
}

// The handle type is declared BY the caret authority, which owns the registry it
// is registered into — the provider cannot reach a handle except through the
// authority's narrow surface, and that is the point (see `caret-authority.ts`).
export type { BlockFocusHandle } from "./internal/caret-authority";

/**
 * Carry the row's existing text projection across a row write.
 *
 * A row write states the fields it owns; `text` is not one of them — it is a
 * ~1 s-debounced projection of the block's content doc, whose sole writer is
 * `projectText`. A type change keeps the block's id, hence its doc, hence its
 * text, so `convertTo`/`update` carry the row's existing projection across
 * untouched rather than restating (or dropping) it. Everywhere else the key is
 * unrepresentable — that is what {@link RowData} buys.
 *
 * It carries the key UNCONDITIONALLY, including into a text-less target. Whether
 * the key may survive on the resulting row is not this function's question:
 * `conformRowText` answers it for every row write at the funnel, so a caller
 * cannot get it wrong by forgetting to ask (which is exactly how the projection
 * — a writer that never called through here — shipped a rejected patch on every
 * text-to-void conversion).
 */
function preserveText(prev: unknown, next: RowData): Record<string, unknown> {
  const text = (prev as Record<string, unknown> | null)?.text;
  if (text === undefined) return { ...next };
  return { ...next, text };
}

/** Empty type set — the `BlockOpContext` default, hoisted so it is stable. */
const EMPTY_TYPES: ReadonlySet<string> = new Set<string>();

/** The patch a pure text entry dispatches: nothing. */
const EMPTY_PATCH: BlockPatch = { creates: [], updates: [], deleteIds: [] };

/**
 * What ONE undo entry of this editor records — the unit of a Cmd+Z. Every
 * recorder in this file funnels into {@link recordEntry} with this shape.
 *
 * `before`/`after` are the full row snapshots around the mutation (equal for a
 * pure text entry); `runsEdits` are the content-doc edits the same gesture
 * made, as DATA — each block's runs before and after
 * (`block-run-tracker.ts`). Undo replays every `runsEdits[i].before` and then
 * dispatches the reverse patch; redo dispatches the forward patch and then
 * replays every `after`. Text before patch on undo, patch before text on redo,
 * so a doc edit always runs while its row exists.
 */
/** `BlockEditorContextValue.splice`'s arguments. */
interface SpliceArgs {
  blockId: string;
  position: number;
  runs: RichText;
  blocks: SerializedBlock[];
  /** What the forest was copied as — see `ForestGranularity`. */
  granularity: ForestGranularity;
}

interface RecordEntryArgs {
  label: string;
  /** The block the user was on; undo/redo restore focus there (see `derivePatchEntry`). */
  focusId: string | null;
  before: Block[];
  after: Block[];
  runsEdits?: readonly BlockRunsEdit[];
  /** Merges run-together edits into one step (a to-do's `checked` flips); structural ops pass none. */
  coalesceKey?: string;
  /**
   * The entry's identity, minted with the write it records (`newHistoryEntryId`): if
   * the server permanently rejects that write, `dropRejectedEntry(id)` removes
   * the entry — its before/after bracket a change that never happened.
   */
  id?: string;
}

/**
 * What an editor shows: the whole page, or — zoomed — one block and its
 * descendants (`BlockEditor`'s `rootId`). Readable from anything rendered inside
 * the editor through {@link useEditorScope}.
 */
export interface EditorScope {
  /** The zoomed block, rendered at depth 0; null for the whole page. */
  rootId: string | null;
  /**
   * The parent a TOP-LEVEL insert lands under: the page's own id on the whole
   * page (the reducer's forest excludes the page row, so its id is how the
   * content top level is addressed), the root's id when zoomed — so a click
   * below the last line, a paste with no anchor and an external drop over
   * nothing all land inside the view.
   */
  contentParentId: string;
}

interface BlockEditorContextValue {
  pageId: string;
  /** See {@link EditorScope}. */
  scope: EditorScope;
  /**
   * Would this op change anything, and stay inside the zoom? The reducer run
   * once over the current rows, then `scopeAdmits` — the same two gates every
   * structural write passes, asked ahead of time so an affordance (the
   * selection bar's indent, a menu item) can hide or disable itself rather than
   * offer a click that is refused. Always the reducer's answer alone on an
   * unzoomed editor.
   *
   * Reads the RENDER-FRESH rows, so it is safe to call during render; it does
   * not see a mutation issued earlier in the same synchronous turn.
   */
  admits: (op: BlockOp) => boolean;
  /** Server truth with all pending structural ops replayed optimistically. */
  blocks: Block[];
  /**
   * Block ids present in AUTHORITATIVE server truth — the raw resource base,
   * with NO optimistic overlay. A freshly created / split block appears in
   * `blocks` immediately but only lands here once the server has really
   * committed its row. Consumers that must wait for the row to be
   * FK-satisfyingly real (the content-doc seed, Stage 4a) gate on this set.
   */
  serverIds: ReadonlySet<string>;
  /**
   * What THIS client knows about a block id in server truth
   * (`internal/row-truth.ts`): `"present"` if it is in {@link serverIds} now,
   * `"removed"` if it was in some earlier authoritative push and is not now,
   * `"unseen"` if this editor has never seen it there. The content-doc seam
   * reads it to decide whether a `data.text` seed may be applied without
   * waiting for the server — a removed row's stored doc survives its delete
   * (every delete is a trash), so only an unseen id may pre-seed. Identity
   * changes with {@link serverIds}, so a consumer re-renders on every push.
   */
  rowTruthOf: (id: string) => RowTruth;
  /**
   * Rows below which content is still loading — an expanded nested page whose
   * own rows have not landed (see `SettledBlockStore.loadingBelow`). The row
   * renders a loading region under itself; nothing else changes. There is no
   * whole-document `pending`: the provider only ever mounts on a settled store
   * (`BlockEditorProviderGate`), so every row here is real.
   */
  loadingBelow: ReadonlySet<string>;
  /**
   * Rows below which an expanded nested page's first load FAILED (see
   * `SettledBlockStore.failedBelow`): the row renders the failure, with Retry,
   * under itself. Disjoint from {@link loadingBelow}.
   */
  failedBelow: ReadonlyMap<string, BelowFailure>;
  /**
   * Optional allowlist of insertable block `type`s. When set, block-type pickers
   * (add-block menu, gutter `+`, slash menu) offer only these types. Undefined
   * (the default) offers every registered block type.
   */
  enabledBlockTypes?: readonly string[];
  /**
   * Whether attachment (file drop / paste-file) affordances are active. False in
   * the in-memory (non-persisting) mode, where there is no server to store an
   * uploaded blob.
   */
  allowAttachments: boolean;
  /**
   * Whether this editor's per-block content docs SYNC to the server (the CRDT
   * transport: `blockDocs` row subscription + `doc-init`/`doc-update`).
   * True on the persistent path; false in the in-memory mode, where each block's
   * `Y.Doc` is purely local (seeded from `data.text`, never networked). Read by
   * `CollabTextPlugin` to pick the server vs local content-doc hook.
   */
  serverSync: boolean;
  focusedBlockId: string | null;
  setFocusedBlockId: (id: string | null) => void;
  registerFocusHandle: (id: string, handle: BlockFocusHandle) => () => void;
  /**
   * Hand the caret authority the block list's interaction surface (the focusable
   * container `useBlockSelection` owns). While a landing is outstanding the
   * authority parks the caret THERE and buffers input from it, so the block the
   * user just left stops being an editing host and nothing can type into it.
   * Called by `BlockEditorInner`; there is exactly one such surface per editor.
   */
  attachContainer: (el: HTMLElement | null) => void;
  makeBlockAPI: (blockId: string) => BlockEditorAPI;
  /**
   * "Strip then convert" — THE single primitive behind every commit that
   * consumes some of a block's own text as a command: the slash menu's
   * `/query`, the gutter-`+` draft's filter, a markdown prefix (`* `, `> `,
   * `# `). One operation, two owners, in this order:
   *
   *  1. delete `[from, to)` from the block's CONTENT DOC through its focus
   *     handle (discrete, so it lands before anything can re-render);
   *  2. write the new `type` to the ROW.
   *
   * The order is the whole point. Text lives in the doc; `data.text` is a
   * projection of it. A convert that carried the stripped text in its row
   * payload could not strip anything — it would leave the doc saying
   * `/callout` while the row said `text: []`, permanently. And a type change
   * that swaps the block's renderer unmounts the very editor holding the doc
   * binding, so a strip deferred past it never happens at all.
   */
  convertStrippingText: (args: {
    blockId: string;
    /** Linear start of the consumed span (stored-runs basis), inclusive. */
    from: number;
    /** Linear end of the consumed span, exclusive. `to <= from` strips nothing. */
    to: number;
    type: string;
    /** Target payload, seeded from the target handle's `emptyRowData()`. */
    data: RowData;
    /** Reset the open/collapsed state in the same write (a toggle opens). */
    expanded?: boolean;
  }) => void;
  /**
   * The strip half of `convertStrippingText`, alone: delete `[from, to)` from
   * the block's content doc and write nothing to the row. For a commit that
   * consumes its query text and then does something OTHER than a type change —
   * an `Editor.InsertAction` — so the query is gone from the line by the same
   * rule, at the same moment, as before a conversion.
   */
  stripText: (args: {
    blockId: string;
    /** Linear start of the consumed span (stored-runs basis), inclusive. */
    from: number;
    /** Linear end of the consumed span, exclusive. `to <= from` strips nothing. */
    to: number;
  }) => void;
  setFlatOrder: (blocks: Block[]) => void;
  /** All blocks of the page (incl. collapsed), kept current for bulk ops. */
  setRows: (blocks: Block[]) => void;
  rowsRef: MutableRefObject<Block[]>;
  /**
   * Focus a block's text editor by id (defers until it mounts if needed). When
   * `caretOffset` is given and the block's editor is already mounted, land the
   * caret at that linear offset (used to restore the caret on a text undo/redo).
   * `opts.scroll` (default false) declares whether the landing follows the caret
   * into view — set for keyboard nav / undo-redo, left off for pointer landings.
   */
  focusBlock: (
    id: string,
    caretOffset?: number,
    opts?: CaretLandOptions,
  ) => void;
  focusBlockBoundary: (
    id: string,
    edge: "start" | "end",
    opts?: CaretLandOptions,
  ) => boolean;
  /**
   * Reorder/reparent `id` to sit immediately `zone` of `targetId`. Positional
   * intent, not a rank — the store owns the rank (the server mints it on the
   * persistent path; the memory store mints its own). See `BlockMoveDest`.
   */
  move: (id: string, zone: "before" | "after", targetId: string) => void;
  /**
   * Nest each of `blockIds` under its previous sibling — the selection-mode Tab.
   * The set moves as one rigid body: a block that cannot indent holds the rest of
   * its run in place rather than swallowing it (see `foldIndent`). A no-op is
   * dropped before it reaches the undo stack or the network.
   */
  indentBlocks: (blockIds: string[]) => void;
  /** Lift each of `blockIds` out to its parent's level — the selection-mode Shift+Tab. */
  outdentBlocks: (blockIds: string[]) => void;
  /**
   * Dissolve the CONTAINER `blockId`: delete it and promote its children into the
   * slot it occupied, order preserved. How the caret escapes a container box —
   * Backspace at the start of an anchor's first child resolves here, and a
   * container's own chrome (the callout icon menu's "Remove callout") uses the
   * same entry point.
   *
   * Takes a block id because the caller is usually standing in a DIFFERENT block
   * (the anchor renders no line and holds no caret), which is also why it lives
   * on the context rather than on a single block's `BlockEditorAPI`.
   */
  unwrapBlock: (blockId: string) => void;
  /** Bulk operations on a set of selected block ids (see server endpoints). */
  bulkDelete: (ids: string[]) => void;
  bulkMove: (args: {
    ids: string[];
    parentId: string | null;
    afterId: string | null;
  }) => void;
  /**
   * Clone each selection root's subtree in place, immediately after its source.
   * A `duplicate` `BlockOp` dispatched through `dispatchOp`, so it is optimistic
   * and recorded as ONE undo entry like every other structural edit.
   *
   * Returns nothing, for `paste`'s reason: the minted root ids are right there
   * in the op, but `dispatchOp` legitimately DROPS an op whose reducer diff is
   * empty, so "the ids that were created" would be an absorbable failure — a
   * caller reading them back would be told clones landed in exactly the case
   * they did not.
   */
  bulkDuplicate: (ids: string[]) => void;
  /**
   * Insert a serialized forest after `afterId` (or, anchorless, at the start of
   * `parentId` — defaulting to the page's own top level). A plain `BlockOp`
   * dispatched through `dispatchOp`, so it is optimistic and recorded as ONE
   * undo entry like every other structural edit.
   *
   * Returns nothing, deliberately. The minted root ids are right there in
   * `withMintedIds`' output, but `dispatchOp` legitimately DROPS an op the
   * reducer refused (a missing anchor refuses the whole paste), so "the ids
   * that were pasted" would be an absorbable failure — a caller reading them
   * back would be told content landed in exactly the case it did not.
   */
  paste: (args: {
    blocks: SerializedBlock[];
    afterId: string | null;
    parentId?: string | null;
  }) => void;
  /**
   * Splice a serialized forest INTO `blockId`'s text at an insertion point — a
   * caret paste, or a drop inside the block's text. One `splice` `BlockOp`
   * (see `planSplice` for the rule), so it is optimistic and ONE undo entry
   * carrying both the structural patch and the origin's text edit; the caret
   * lands at the end of what was pasted.
   *
   * `runs` are the block's LIVE runs with any selected range already removed,
   * and `position` the insertion point in them — split's two inputs. Returns
   * nothing, for `paste`'s reason: a refused splice is dropped before it
   * reaches the network, so a returned id would be an absorbable failure.
   */
  splice: (args: {
    blockId: string;
    position: number;
    runs: RichText;
    blocks: SerializedBlock[];
    /** What the forest was copied as — see `ForestGranularity`. */
    granularity: ForestGranularity;
  }) => void;
  /**
   * Where a drop at viewport point `(x, y)` inside `blockId`'s text would land:
   * the block's live runs and the linear offset under the pointer — `splice`'s
   * two inputs. Null when the block has no text surface mounted, or the point
   * is not in its text (the caller then lands the drop as blocks, after the
   * row). Moves no caret.
   */
  insertionPointAt: (
    blockId: string,
    x: number,
    y: number,
  ) => { position: number; runs: RichText } | null;
  /**
   * The text reads of `blockId`'s MOUNTED text surface — what an editor-owned
   * span across blocks is built from (the anchor and head under the pointer,
   * the live text) and painted with (DOM Ranges, update notifications). Null
   * when no text editor is mounted for it. Reads only: nothing here edits
   * content or places a caret, so the surface can hold it freely.
   */
  textReadsOf: (blockId: string) => BlockTextReads | null;
  /**
   * Delete the text span `[from, to)` — `from` and `to` in visible order, as
   * `normalizeSpan` hands them out — and land the caret at the join.
   *
   * Inside one block it is a text edit of that block (one doc entry). Across
   * blocks it is ONE `deleteSpan` op: the start line keeps its head and takes
   * the end line's tail, everything between goes, in one undo entry and one
   * server transaction (see `applyDeleteSpan` for which lines go and which are
   * lifted).
   */
  deleteSpan: (
    from: SpanPoint,
    to: SpanPoint,
    /**
     * What REPLACES the span (typing over it), always ONE undo step with the
     * delete, as typing over a selection inside one block is one run. One
     * typed CHARACTER — or Shift+Enter's soft line break — is part of the
     * span's own edit (head + character + tail, one op). A plain Enter splits
     * the join line in the same entry (`breakSpan`: the `deleteSpan` op then
     * the `split` op). Any other key is replayed at the join once the caret
     * lands there, through the caret authority's flight buffer
     * (`landWithInput`) — the one path buffered input takes into a block.
     */
    input?: readonly FlightInput[],
  ) => void;
  /**
   * Replace the text span `[from, to)` with a pasted forest — a paste while a
   * span is selected. The span is deleted and the forest SPLICED at the join
   * (`planSplice`, `granularity` deciding as for any caret paste), as ONE undo
   * entry: a paste that creates no line is the span's own edit with the pasted
   * text in its result (one `deleteSpan` op, or a text edit inside one block);
   * one that creates lines is the `deleteSpan` op then the `splice` op,
   * predicted in sequence and recorded as a single entry over both.
   */
  replaceSpan: (
    from: SpanPoint,
    to: SpanPoint,
    insert: { blocks: SerializedBlock[]; granularity: ForestGranularity },
  ) => void;
  /**
   * Create a block of the given type at the end of the page and focus it
   * once the live resource re-renders the list.
   */
  insert: (type: string, data: unknown) => void;
  /**
   * Create a block of the given type at the TOP of the page and focus it —
   * prepended before the current first top-level block (or appended when the
   * page has no content yet). Drives the page title's Enter affordance.
   */
  insertFirst: (type: string, data: unknown) => void;
  /**
   * Projection writer: persist the content doc's current runs to `data.text`
   * WITHOUT recording on the undo stack (Yjs owns text history). Keeps row
   * readers — search, backlinks, history snapshots, read-only views — fresh.
   * No-ops when the block row no longer exists.
   *
   * `runs` is branded `DocSourcedRuns`: only `projectableRunsOf` (which reads
   * the block's own content `Y.Doc`) can produce that type, so persisting a
   * value the projection did not read from the doc's OWNER is a compile error —
   * never again a serialization of some editor's VIEW of it. See
   * `internal/doc-sourced-runs.ts`.
   */
  projectText: ProjectTextFn;
  /**
   * Row writer for an editing surface that has ALREADY put this edit on the
   * undo stack itself — today exactly `useBlockPlainText`, the one sanctioned
   * plain-text control a block may own (`<BlockTextArea>`).
   *
   * Same optimistic pipeline as `BlockEditorAPI.update`, with `record: false`
   * — the same exemption `projectText` takes, for the same reason: something
   * else owns this edit's history. Such a surface edits at INPUT frequency, so
   * it cannot pay for a row write per keystroke; it records synchronously (so
   * Cmd+Z reaches the keystroke you just typed) and persists on a timer. If
   * the timer's write recorded too, one typing burst would cost TWO Cmd+Z —
   * and the first of them would revert only the row while the control kept
   * rendering its own draft, i.e. an undo that visibly does nothing.
   *
   * Deliberately NOT on `BlockEditorAPI`: a block renderer must not be able to
   * write a row off the history by accident. Reaching this takes
   * `useBlockEditor()` and a deliberate claim that the edit is recorded.
   */
  commitRecordedRowData: (blockId: string, data: RowData) => void;
  /**
   * Text-history recorder: record ONE closed typing run — the block's runs
   * before and after it, as data — as an entry on the unified undo stack.
   * Called by `CollabTextPlugin` from the content-doc seam's `onRunsEdit`.
   * Replay brings the block back to those runs on whichever host holds it
   * then (its open doc, or its stored doc through the server) — never a
   * pointer that can go stale.
   */
  recordTextEdit: (edit: BlockRunsEdit) => void;
  /**
   * Record a content-doc edit as ONE standalone text undo entry, under its own
   * `label`. Defers `edit` one microtask (a caller inside a Lexical command
   * handler or update listener is inside an `editor.update()`, where a nested
   * `discrete` update is enqueued rather than committed), then runs it inside
   * the owner's `untracked` scope between two `runsNow()` reads, so the run
   * tracker neither opens a run for it nor folds it into the typing run around
   * it. No-ops when the edit changed nothing; with no live owner the edit
   * simply runs (there is no doc to record against).
   *
   * It lives here rather than in the calling component so that ALL undo
   * recording stays at this documented chokepoint — and it hands the same
   * capability to any future "toolbar bold as its own undo step".
   */
  recordDocEdit: (blockId: string, label: string, edit: () => void) => void;
  /** Structural (document-tier) undo — reverses the last recorded block edit. */
  undo: () => void;
  /** Structural (document-tier) redo — re-applies the last undone block edit. */
  redo: () => void;
  /** Whether there is a recorded structural edit to undo. */
  canUndo: boolean;
  /** Whether there is an undone structural edit to redo. */
  canRedo: boolean;
  /**
   * The block id whose gutter-`+` draft menu is currently open, or null. The
   * gutter `+` inserts an empty paragraph, focuses it, and flags it here; that
   * block's `BlockMenuPlugin` force-opens the shared caret menu inline-filtered
   * by the block's own text. Doubles as the placeholder trigger ("Type to
   * filter" while the draft menu is open).
   */
  blockMenuDraftId: string | null;
  /** Open the gutter-`+` draft menu on `id` (set after inserting the block). */
  requestBlockMenu: (id: string) => void;
  /** Clear the draft menu — unconditionally, or only if it is still on `id`. */
  clearBlockMenu: (id?: string) => void;
}

const BlockEditorContext = createContext<BlockEditorContextValue | null>(null);

export function useBlockEditor(): BlockEditorContextValue {
  const ctx = useContext(BlockEditorContext);
  if (!ctx)
    throw new Error("useBlockEditor must be used within a BlockEditorProvider");
  return ctx;
}

/**
 * The {@link EditorScope} of the enclosing editor — whether it shows the whole
 * page or one zoomed block, and where its top level is. For components a block
 * or a slot contribution renders inside the editor (a block-menu item that must
 * not offer to open the block the view is already zoomed into).
 */
export function useEditorScope(): EditorScope {
  const ctx = useContext(BlockEditorContext);
  if (!ctx)
    throw new Error("useEditorScope must be used within a BlockEditorProvider");
  return ctx.scope;
}

/**
 * The insertable-type allowlist of the nearest `BlockEditorProvider`, or
 * undefined outside one / when unrestricted. Read by `useInsertableBlocks` so the
 * palette filter applies to every block-type picker with no per-menu wiring.
 */
export function useEnabledBlockTypes(): readonly string[] | undefined {
  return useContext(BlockEditorContext)?.enabledBlockTypes;
}

/**
 * Props shared by both provider modes. `persist` picks the store: the default
 * (persistent) reads/writes `pageBlocks` + the server endpoints; `false`
 * runs a self-contained in-memory document seeded from `initialBlocks` (no
 * network, no DB rows).
 */
type BlockEditorProviderProps = {
  /** Optional allowlist of insertable block types (see the context field). */
  enabledBlockTypes?: readonly string[];
  /** See `BlockEditor`'s props — the caret surfaces flanking the block list. */
  caretBefore?: CaretSurfaceRef;
  caretAfter?: CaretSurfaceRef;
  /** See `BlockEditor`'s props — the block this editor is zoomed into. */
  rootId?: string;
  children: ReactNode;
} & (
  | { persist?: true; pageId: string }
  | { persist: false; pageId: string; initialBlocks: Block[] }
);

export function BlockEditorProvider(props: BlockEditorProviderProps) {
  // `persist` is fixed for a mounted editor, so switching component by it is not
  // a hooks-order hazard — each host calls exactly one store hook.
  if (props.persist === false) {
    return (
      <MemoryProviderHost
        pageId={props.pageId}
        initialBlocks={props.initialBlocks}
        enabledBlockTypes={props.enabledBlockTypes}
        caretBefore={props.caretBefore}
        caretAfter={props.caretAfter}
        rootId={props.rootId ?? null}
      >
        {props.children}
      </MemoryProviderHost>
    );
  }
  // The server path is the COMPOSITE host (composite-block-store.tsx): one
  // feed per expanded nested page, composed into a single union store. With no
  // expansion it degenerates to exactly the old single-feed ServerProviderHost.
  return (
    <CompositeServerProviderHost
      pageId={props.pageId}
      enabledBlockTypes={props.enabledBlockTypes}
      caretBefore={props.caretBefore}
      caretAfter={props.caretAfter}
      rootId={props.rootId ?? null}
    >
      {props.children}
    </CompositeServerProviderHost>
  );
}

/**
 * The storage-agnostic props both hosts thread through to the inner provider:
 * the flanking caret surfaces and the zoom root.
 */
export interface ProviderHostViewProps {
  caretBefore?: CaretSurfaceRef;
  caretAfter?: CaretSurfaceRef;
  /** The zoomed block (see `EditorScope`); null for the whole page. */
  rootId: string | null;
}

function MemoryProviderHost({
  pageId,
  initialBlocks,
  enabledBlockTypes,
  caretBefore,
  caretAfter,
  rootId,
  children,
}: {
  pageId: string;
  initialBlocks: Block[];
  enabledBlockTypes?: readonly string[];
  children: ReactNode;
} & ProviderHostViewProps) {
  const store = useMemoryBlockStore({ initialBlocks });
  return (
    <BlockEditorProviderInner
      store={store}
      pageId={pageId}
      serverSync={false}
      enabledBlockTypes={enabledBlockTypes}
      caretBefore={caretBefore}
      caretAfter={caretAfter}
      rootId={rootId}
    >
      {children}
    </BlockEditorProviderInner>
  );
}

type ProviderInnerProps = {
  store: SettledBlockStore;
  pageId: string;
  /**
   * Persistence mode: server-backed (true) vs in-memory (false). The single
   * source for both derived affordances — `allowAttachments` (no blob storage
   * without a server) and content-doc `serverSync` (no CRDT transport in
   * memory) are both `serverSync` on the context.
   */
  serverSync: boolean;
  enabledBlockTypes?: readonly string[];
  /** See `BlockEditor`'s props — the caret surfaces flanking the block list. */
  caretBefore?: CaretSurfaceRef;
  caretAfter?: CaretSurfaceRef;
  /**
   * The zoomed block (see `EditorScope`), or null for the whole page. Required
   * rather than optional so each host states which it is.
   */
  rootId: string | null;
  children: ReactNode;
};

/**
 * The gate between a store that can still be loading and the provider, whose
 * hooks read the rows, the authoritative rows and `dispatch` unconditionally:
 * while the store is pending it renders the editor's loading state (or the
 * failure, when its first load failed), and it
 * mounts the provider only with a settled store. The provider's `store` prop is
 * the settled arm, so a store that can be pending reaches it only through here
 * (tsc); the memory store is settled from the start.
 *
 * The provider — and so everything it holds (focus, the mount-scoped undo
 * entries, the caret authority) — mounts once the page's rows land. The
 * store is keyed by the page, so it goes back to pending only when the page
 * itself changes, and a different page is a fresh editor.
 */
export function BlockEditorProviderGate({
  store,
  ...props
}: Omit<ProviderInnerProps, "store"> & { store: BlockStore }) {
  if (store.pending) {
    // A failed first load is its own state, never an endless loading one.
    if (store.error !== null) {
      return (
        <ResourceErrorInline
          error={store.error}
          refetch={store.refetch}
          variant="block"
          subject="this page"
        />
      );
    }
    return <Loading variant="rows" />;
  }
  return <BlockEditorProviderInner store={store} {...props} />;
}

// Exported for the provider hosts only (the composite server host lives in
// composite-block-store.tsx, behind `BlockEditorProviderGate`); apps never mount
// it directly — use `BlockEditorProvider`.
export function BlockEditorProviderInner({
  store,
  pageId,
  serverSync,
  enabledBlockTypes,
  caretBefore,
  caretAfter,
  rootId,
  children,
}: ProviderInnerProps) {
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [blockMenuDraftId, setBlockMenuDraftId] = useState<string | null>(null);
  // Block-type facts the pure reducer and `convertTo` cannot derive from the
  // forest: the reducer's `BlockOpContext` (the store passes the SAME context,
  // and so does the server — all three mint it through `blockOpContextOf`) and
  // the handle registry `convertTo` reads `wrapOnConvert`/`empty()` off.
  const opCtx = useBlockOpContext();
  const anchorTypes = opCtx.anchorTypes ?? EMPTY_TYPES;
  // The same fact in the shape the visibility helpers take. A container borrows
  // its first child's line, so `prevVisibleLine`/`nextVisibleLine` cannot resolve
  // a merge target without it — pass anything else and the executor's target
  // disagrees with the reducer's, which is a merge that fires and does nothing.
  const isAnchorNode = useCallback(
    (node: BlockNode) => anchorTypes.has(node.type),
    [anchorTypes],
  );
  const blockHandles = useBlockHandles();
  // Read only inside `conformRowText`, which runs per row inside `commitRows` —
  // a ref keeps that callback's identity stable across registry churn.
  const blockHandlesRef = useLatestRef(blockHandles);
  // The flanking surfaces are read only inside imperative callbacks, so mirror
  // them into refs rather than threading them through `makeBlockAPI`'s deps.
  const caretBeforeRef = useLatestRef(caretBefore);
  const caretAfterRef = useLatestRef(caretAfter);
  const flatOrderRef = useRef<Block[]>([]);
  const rowsRef = useRef<Block[]>([]);

  // The persistence seam. All reads (`data`/`serverData`/`loadingBelow`) and
  // writes (`dispatch`) go through it; everything else in this
  // provider (recording, focus, `makeBlockAPI`, the CRDT projection) is
  // storage-agnostic — the server and in-memory stores share ONE shape.

  // Render-fresh view of the current rows. `rowsRef` (set by a consumer
  // EFFECT) lags within a commit: when a structural patch removes a block, the
  // removed block's unmount cleanups run BEFORE the effect that refreshes
  // `rowsRef` — so existence checks against `rowsRef` in unmount paths see the
  // deleted row as still alive. `useLatestRef` writes during the provider's
  // render, which precedes those unmount cleanups in the same commit.
  const liveRowsRef = useLatestRef(store.data);

  // --- The zoom -------------------------------------------------------------
  // The store, the reducer and the endpoints stay on the FULL page (so the
  // predicted forest is the server's); only the view is scoped. What keeps a
  // zoomed write inside the view is `admitsRows`, checked at every structural
  // write chokepoint below — `dispatchOp`, `applyOverlay`, the mounted merge and
  // `commitRows` — beside the reducer's own "wrote nothing" refusal. Undo/redo
  // patches are exempt: they restore states this editor already recorded.
  const scope = useMemo<EditorScope>(
    () => ({ rootId, contentParentId: rootId ?? pageId }),
    [rootId, pageId],
  );
  const admitsRows = useCallback(
    (before: readonly Block[], after: readonly Block[]) =>
      rootId === null || scopeAdmits(before, after, rootId),
    [rootId],
  );

  /**
   * The insert fields that land a new row FIRST under `parentId`: before its
   * current first child, or — childless — as its only one. The page's top line
   * (`insertFirst`) and "right below the zoom root" (an insert or paste
   * anchored ON the root, which would otherwise land after it, outside the view)
   * are the same position.
   */
  const firstUnder = useCallback(
    (parentId: string): { beforeId: string } | { parentId: string } => {
      const first = childrenOf(toNodes(rowsRef.current), parentId)[0];
      return first ? { beforeId: first.id } : { parentId };
    },
    [],
  );

  /**
   * A selection delete or duplicate naming the zoom root acts on its CHILDREN
   * instead: the root is the view itself, so removing it would leave nothing to
   * show and cloning it would land the copy outside. Selecting the root selects
   * everything in view, so "delete everything I see" empties the root.
   */
  const withoutScopeRoot = useCallback(
    (ids: string[]): string[] => {
      if (rootId === null || !ids.includes(rootId)) return ids;
      const kids = childrenOf(toNodes(rowsRef.current), rootId).map(
        (c) => c.id,
      );
      return [...ids.filter((id) => id !== rootId), ...kids];
    },
    [rootId],
  );

  // Ids the SERVER has committed (see the interface doc) — recomputed on each
  // authoritative push, so the "row is now real" edge (the doc-init FK gate)
  // propagates push-based. In memory the store's `serverData` is every row, so
  // this covers all blocks (no gate).
  const serverIds = useMemo(
    () => new Set(store.serverData.map((b) => b.id)),
    [store.serverData],
  );
  // Every id this editor has EVER seen in server truth — monotonic, grown from
  // each authoritative push and never shrunk. Together with `serverIds` it
  // derives `RowTruth` (see the interface doc): an id that left the set was
  // deleted, and a delete is a trash whose stored doc survives — so the doc
  // seam must not pre-seed it. An id never seen here is client-minted; nothing
  // can be stored for it. Grown in an effect (one per push) and read only from
  // the callback below, never in render; a child's render in the same commit
  // asks about ids that were present in an EARLIER push, which this effect has
  // already recorded.
  const everServerIdsRef = useRef(new Set<string>());
  // The SAME transition, as a promise: a text replay onto a row that was just
  // re-created optimistically (undo of a delete) must not doc-init a row the
  // server may not have yet, so it waits — push-based, off this effect — for
  // the authoritative push that carries the id (`block-text-write-stored.ts`).
  // A waiter is only ever registered for a row in THIS client's rows (the
  // optimistic create it is waiting on); the moment that row leaves them
  // without having entered server truth — the create was rolled back or
  // denied — nothing will ever confirm it, so the waiter is REJECTED, loudly,
  // rather than left pending (a pending replay wedges the tab's serialized
  // undo queue). Keyed on the rows too, since a rollback is a rows change.
  const serverIdsRef = useLatestRef(serverIds);
  const rowWaitersRef = useRef(
    new Map<string, { resolve: () => void; reject: (err: Error) => void }[]>(),
  );
  useEffect(() => {
    const ever = everServerIdsRef.current;
    for (const id of serverIds) ever.add(id);
    const waiters = rowWaitersRef.current;
    for (const [id, list] of waiters) {
      if (serverIds.has(id)) {
        waiters.delete(id);
        for (const w of list) w.resolve();
      } else if (!liveRowsRef.current.some((b) => b.id === id)) {
        waiters.delete(id);
        for (const w of list)
          w.reject(
            new Error(
              `text replay waited for row "${id}" to enter server truth, but its optimistic create was rolled back`,
            ),
          );
      }
    }
  }, [serverIds, store.data, liveRowsRef]);
  useEffect(() => {
    const waiters = rowWaitersRef.current;
    return () => {
      // The editor is gone, and with it the store whose push would have
      // resolved these. A replay left hanging would wedge the tab's serialized
      // undo queue forever; a loud rejection reaches the crash collector.
      for (const [id, list] of waiters) {
        for (const w of list)
          w.reject(
            new Error(
              `page editor unmounted while a text replay waited for row "${id}"`,
            ),
          );
      }
      waiters.clear();
    };
  }, []);
  const waitRowPresent = useCallback(
    (id: string): Promise<void> => {
      if (serverIdsRef.current.has(id)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const list = rowWaitersRef.current.get(id) ?? [];
        list.push({ resolve, reject });
        rowWaitersRef.current.set(id, list);
      });
    },
    [serverIdsRef],
  );
  const rowTruthOf = useCallback(
    (id: string): RowTruth => {
      if (serverIds.has(id)) return "present";
      return everServerIdsRef.current.has(id) ? "removed" : "unseen";
    },
    [serverIds],
  );

  // --- The caret authority ---------------------------------------------------
  // The ONE owner of "where the caret is" and of the block focus-handle registry
  // (`internal/caret-authority.ts`). Everything below hands it a landing policy;
  // nothing below can reach a handle to focus one itself, which is what makes the
  // mount-gap race unreintroducible rather than merely fixed.
  const liveIds = useMemo(
    () => new Set(store.data.map((b) => b.id)),
    [store.data],
  );
  const getOriginId = useEventCallback(() => focusedBlockId);
  const isLiveRow = useEventCallback((id: string) => liveIds.has(id));
  const [authority] = useState(() =>
    createCaretAuthority({ getOriginId, isLiveRow }),
  );

  // Push-based flight bound, never a timer: every commit is a fresh view of what
  // the surface RENDERS, so a claimed landing whose block never becomes a visible
  // line — a refused op, or a target inside a collapsed ancestor — is detected
  // and the buffered keystrokes go back to the origin. `flatOrderRef` is the
  // consumer's own flatten, written by a DESCENDANT's effect, which React runs
  // before this one in the same commit. No dep array: a commit that changed
  // nothing else is still evidence.
  useEffect(() => {
    authority.reconcile((id) => flatOrderRef.current.some((b) => b.id === id));
  });

  const registerFocusHandle = useCallback(
    (id: string, handle: BlockFocusHandle) =>
      authority.registerHandle(id, handle),
    [authority],
  );

  const setFlatOrder = useCallback((blocks: Block[]) => {
    flatOrderRef.current = blocks;
  }, []);

  const setRows = useCallback((blocks: Block[]) => {
    rowsRef.current = blocks;
  }, []);

  /**
   * Advance `rowsRef` to the rows a mutation THIS TURN just produced.
   *
   * `rowsRef` is refreshed by a consumer effect, i.e. once per React commit, so
   * two mutations issued in the same synchronous turn both snapshot the
   * PRE-first-mutation rows — and each writes its own full rows back. The second
   * then silently reasserts the first's columns: replaying a buffered `Tab` and
   * then the `* ` markdown prefix ran `indent` (an op) and `convertTo` (a patch)
   * in one turn, and the patch's upsert carried the pre-indent `parentId`,
   * un-indenting the block on the server. Captured as
   * `[PATCHDIAG] upserts=<item><-<page>` with no intervening commit.
   *
   * A human never noticed because React commits between their keystrokes; the
   * caret authority replays a whole buffer inside one turn, so a mutation now
   * routinely follows another with no commit in between. Every chokepoint that
   * computes an `after` publishes it here, so the next one in the same turn
   * builds on it. The consumer effect still overwrites this on the next commit
   * with the real (optimistically-overlaid) rows, so it can never drift.
   */
  const advanceRows = useCallback((after: Block[]) => {
    rowsRef.current = after;
  }, []);

  const requestBlockMenu = useCallback(
    (id: string) => setBlockMenuDraftId(id),
    [],
  );
  const clearBlockMenu = useCallback(
    (id?: string) =>
      setBlockMenuDraftId((cur) => (id == null || cur === id ? null : cur)),
    [],
  );

  const focusBlock = useCallback(
    (id: string, caretOffset?: number, opts?: CaretLandOptions) => {
      authority.land(id, (handle, land) => {
        // When a caret offset is requested and this block is a text editor, land
        // the caret precisely (the same leaf-aware placement `merge` uses); else a
        // plain focus restoring its last selection.
        if (caretOffset !== undefined && handle.focusOffset) {
          handle.focusOffset(caretOffset, { ...opts, ...land });
        } else handle.focus({ ...opts, ...land });
      });
    },
    [authority],
  );

  const focusBlockBoundary = useCallback(
    (id: string, edge: "start" | "end", opts?: CaretLandOptions): boolean =>
      // Boundary landings answer a question — "can this row take a caret?" — that
      // only a MOUNTED host can answer, and the empty-background click falls back
      // to selecting the row on `false`. So this never claims a flight.
      authority.landIfMounted(id, (handle, land) => {
        if (handle.focusBoundary)
          handle.focusBoundary(edge, { ...opts, ...land });
        else handle.focus({ ...opts, ...land });
      }),
    [authority],
  );

  // --- Unified undo/redo (single document-level stack) ----------------------
  // ONE stack covers both text and structure (there is no per-block Lexical
  // `HistoryPlugin`): structural ops (create/split/merge/indent/outdent/delete/
  // move/convert/bulk) AND text edits (each closed typing run, as the block's
  // runs before and after it). Every entry is DATA — a patch pair and/or a list
  // of `BlockRunsEdit`s — recorded through the ONE recorder below,
  // `recordEntry`, at the mutation chokepoints: snapshot the current rows,
  // compute the resulting rows, diff into a minimal patch pair, capture the doc
  // runs a surgery moved, and `record` thunks that replay them onto the CURRENT
  // state.
  // SCOPED: the stack itself is the tab's (mounted in `TabSurface`), but these
  // thunks close over THIS editor's mount — the per-`pageId` optimistic store
  // and its row truth. So the editor's entries are dropped when it unmounts (a
  // Miller `swap` remounts the column on page navigation), leaving other
  // plugins' mount-free entries on the stack.
  const { record, undo, redo, canUndo, canRedo, dropEntry } =
    useScopedUndoRedo();
  // A write's `onRejected` (see `SettledBlockStore.dispatch`): the server
  // permanently refused it, so the undo entry recorded with it describes a
  // change that never happened — replaying it would act on a state that never
  // existed. Idempotent (a write routed to several pages may call it twice).
  const dropRejectedEntry = useCallback(
    (id: string) => () => dropEntry(id),
    [dropEntry],
  );
  // Seal every block's open typing run before an undo/redo pops: the run the
  // user is in the middle of is then the entry on top, not the one below it.
  usePendingFlush(closeAllOpenTextRuns);

  // Dispatch a minimal patch through the store's overlay pipeline (instant
  // overlay + server reconcile on the persistent path; a synchronous state write
  // in memory). Goes DIRECTLY to `store.dispatch`, never through
  // `recordEntry`, so a replayed patch is never re-recorded — and the
  // primitive's re-entrancy guard ignores `record` during replay anyway.
  //
  // The ONE place a patch's creates are sorted into creates and RESTORES: a
  // create whose id this editor has seen in server truth and that is not there
  // now (`RowTruth` `"removed"`) restores a trashed row, whose stored fields
  // the server keeps — so the overlay must judge it by presence alone (see
  // `restoreIds` on `BlockOverlayOp`). Derived from the same two sets
  // `rowTruthOf` reads, through their refs: this runs from undo/redo thunks
  // and commit callbacks, after the push that grew `everServerIds` committed,
  // and a render-keyed identity here would re-mint every consumer on each
  // push for nothing.
  const dispatchPatch = useCallback(
    (patch: BlockPatch, onRejected?: () => void) => {
      if (isEmptyPatch(patch)) return;
      const restoreIds = new Set(
        patch.creates
          .map((c) => c.id)
          .filter(
            (id) =>
              !serverIdsRef.current.has(id) && everServerIdsRef.current.has(id),
          ),
      );
      store.dispatch(buildPatchOverlayOp(patch, { restoreIds }), onRejected);
    },
    [store, serverIdsRef],
  );

  // Replay ONE `BlockRunsEdit` in `direction`: bring the block to the entry's
  // `before` (undo) or `after` (redo), checking that it currently holds the
  // other side (a mismatch is a second writer — applied anyway, reported as a
  // `stale-entry` conflict). `applyBlockRuns` picks the host — the block's open
  // canonical doc when an editor holds one, its stored doc through the server
  // otherwise, the row itself in memory mode — and waits, push-based, for a
  // re-created row to enter server truth before ever touching a stored doc.
  const replayRunsEdit = useCallback(
    async (edit: BlockRunsEdit, direction: "undo" | "redo"): Promise<void> => {
      const { blockId } = edit;
      const rowOf = (): Block | undefined =>
        liveRowsRef.current.find((b) => b.id === blockId) ??
        rowsRef.current.find((b) => b.id === blockId);
      await applyBlockRuns({
        blockId,
        runs: direction === "undo" ? edit.before : edit.after,
        expected: direction === "undo" ? edit.after : edit.before,
        direction,
        serverSync,
        // Host B's doc-init proposal: the row's own projection, read at apply
        // time (only ever used for a block the server holds no doc for).
        rowRuns: () => runsOfNode(rowOf() ?? {}),
        // Memory mode, no owner: the row IS the text. A field-scoped update
        // straight into the overlay — this is a replay, so nothing records.
        writeRow: (runs) => {
          const row = rowOf();
          if (!row) return;
          dispatchPatch({
            creates: [],
            updates: [
              {
                id: blockId,
                changes: {
                  data: { ...((row.data as object | null) ?? {}), text: runs },
                },
              },
            ],
            deleteIds: [],
          });
        },
        rowPresent: () => serverIdsRef.current.has(blockId),
        // The render-fresh rows — the same set the waiter effect reads, so
        // "wait for it" and "reject, it was rolled back" judge one fact.
        rowLive: () => liveRowsRef.current.some((b) => b.id === blockId),
        waitRowPresent: () => waitRowPresent(blockId),
      });
    },
    [serverSync, liveRowsRef, dispatchPatch, serverIdsRef, waitRowPresent],
  );

  // THE recorder. Every undo entry this editor puts on the stack — structural,
  // text, or a gesture that is both (split, merge) — is recorded here and
  // nowhere else. It:
  //
  //  - seals every block's open typing run FIRST, so a structural op never
  //    records ahead of the run that preceded it (the run's own entry lands
  //    below this one, and LIFO pops this one first);
  //  - pins every removed row's `data.text` to its doc's live runs in the
  //    reverse patch (`derivePatchEntry` → `pinRestoredText`);
  //  - bails only when the patches are empty AND there is no runs edit;
  //  - on undo replays each runs edit's `before` and THEN dispatches the
  //    reverse patch; on redo dispatches the forward patch and THEN replays
  //    each `after` — a doc edit always runs while its row exists;
  //  - restores focus at the recorded caret when the entry carries one for the
  //    block it lands on (a replay lands in the binding as a remote edit, so
  //    without it the cursor would drift), else a plain focus.
  //
  // The thunks are async only for the replay's sake; the undo-redo primitive
  // serializes turns, so a second Cmd+Z during an in-flight stored-doc write
  // queues behind it instead of running under the replay guard.
  const recordEntry = useCallback(
    ({
      label,
      focusId,
      before,
      after,
      runsEdits = [],
      coalesceKey,
      id,
    }: RecordEntryArgs) => {
      closeAllOpenTextRuns();
      const derived = derivePatchEntry(before, after, focusId);
      if (!derived && runsEdits.length === 0) return;
      const { undoPatch, redoPatch, undoFocus, redoFocus } = derived ?? {
        undoPatch: EMPTY_PATCH,
        redoPatch: EMPTY_PATCH,
        undoFocus: focusId,
        redoFocus: focusId,
      };
      // The recorded caret for the block undo/redo lands on, clamped into the
      // text that replay restores there (the offset is an approximation read
      // at run close — see `useRunsEditRecorder` — and must never exceed it).
      const caretFor = (
        id: string | null,
        direction: "undo" | "redo",
      ): number | undefined => {
        const edit = runsEdits.find((e) => e.blockId === id);
        if (!edit) return undefined;
        const caret = direction === "undo" ? edit.caretBefore : edit.caretAfter;
        if (caret === undefined) return undefined;
        const restored = direction === "undo" ? edit.before : edit.after;
        return Math.min(caret, runsLength(restored));
      };
      const land = (id: string | null, caret: number | undefined): void => {
        // Undo/redo reveals the affected block — it may be off-screen.
        if (id) queueMicrotask(() => focusBlock(id, caret, { scroll: true }));
      };
      record({
        label,
        coalesceKey,
        id,
        undo: async () => {
          for (const e of runsEdits) await replayRunsEdit(e, "undo");
          dispatchPatch(undoPatch);
          land(undoFocus, caretFor(undoFocus, "undo"));
        },
        redo: async () => {
          dispatchPatch(redoPatch);
          for (const e of runsEdits) await replayRunsEdit(e, "redo");
          land(redoFocus, caretFor(redoFocus, "redo"));
        },
      });
    },
    [record, dispatchPatch, focusBlock, replayRunsEdit],
  );

  // A structural op is a patch-only entry. Never coalesces (each is a distinct
  // undo step), so it passes no `coalesceKey`.
  const recordStructural = useCallback(
    (
      before: Block[],
      after: Block[],
      label: string,
      focusId: string | null,
      id?: string,
    ) => {
      recordEntry({ label, focusId, before, after, id });
    },
    [recordEntry],
  );

  // A closed typing run is a text-only entry: equal row snapshots, one runs
  // edit. Deliberately NO `coalesceKey` — the run tracker already grouped the
  // keystrokes (one entry per idle-closed run), and app-level coalescing would
  // merge two runs' data into one entry whose `before`/`after` no longer bracket
  // what a single Cmd+Z reverts.
  const recordTextEdit = useCallback(
    (edit: BlockRunsEdit) => {
      const rows = rowsRef.current;
      recordEntry({
        label: "Edit text",
        focusId: edit.blockId,
        before: rows,
        after: rows,
        runsEdits: [edit],
      });
    },
    [recordEntry],
  );

  // Standalone content-doc recorder (the inline-markdown autoformat, the
  // mark-boundary unmark): ONE text entry of its own, under the caller's label,
  // fenced off the typing run on both sides. See the interface doc for the
  // deferral; the `untracked` scope is what keeps the run tracker from also
  // recording the same edit as typing — and it closes the open run first, so
  // the entry sits ABOVE a fully recorded typing run rather than inside it.
  const recordDocEdit = useCallback(
    (blockId: string, label: string, edit: () => void) => {
      queueMicrotask(() => {
        const owner = blockDocOwnerOf(blockId);
        if (!owner) {
          edit();
          return;
        }
        const before = owner.runsNow();
        owner.untracked(edit);
        const after = owner.runsNow();
        if (runsEqual(before, after)) return;
        const rows = rowsRef.current;
        recordEntry({
          label,
          focusId: blockId,
          before: rows,
          after: rows,
          runsEdits: [{ blockId, before, after }],
        });
      });
    },
    [recordEntry],
  );

  // The row model's ONE text rule, enforced where every direct row write lands:
  //
  //     `data.text` is present on a row IFF its type accepts text.
  //
  // Both halves are a 400 at the write boundary otherwise — the key is
  // unrecognized on a void type's strict schema, and its ABSENCE is a missing
  // required field on a text-bearing one. Stating it here rather than at each
  // call site is the point: it used to live in `preserveText` alone, so
  // `projectText` (a writer that never calls through it) posted `text` at rows
  // it had just watched become dividers, and `convertTo` into a text type wrote
  // a row the server refused whole — losing the conversion.
  //
  // Writers state their intent; this is where that intent meets the row model.
  const conformRowText = useCallback(
    (row: Block): Block => {
      const handle = blockHandlesRef.current.get(row.type);
      // No registered handle, NO OPINION — deliberately NOT the same branch as a
      // void handle. A type can be missing because it was renamed or removed
      // while its rows live on, because this host mounted a subset of the block
      // plugins, or because the row belongs to another page in the composite
      // union. Stripping those rows' `text` would delete content; filling them
      // would invent the very key this exists to keep out. An unknown type still
      // reaches the write boundary and is still rejected there, loudly.
      if (!handle) return row;
      // `hasTextKey` / `rowDataOf` (`core/row-data.ts`) are the reader and the
      // stripper for exactly this key, so the branded blob is never widened with
      // a cast here. PRESENCE, not emptiness: `[]` is a legitimate value for a
      // text-bearing row, and the key itself is what either schema accepts or
      // rejects.
      const carries = hasTextKey(row.data);
      // `handle.text` is the declared text lens, present IFF the type is
      // text-bearing — the same fact `acceptsText` is derived from, and the same
      // discriminator `markdown-apply`'s `survivorData` uses for this rule on the
      // agent-facing write path.
      if (!handle.text) {
        return carries ? { ...row, data: rowDataOf(row.data) } : row;
      }
      return carries
        ? row
        : {
            ...row,
            data: {
              ...rowDataOf(row.data),
              text: handle.text(handle.empty?.() ?? {}),
            },
          };
    },
    [blockHandlesRef],
  );

  // THE single chokepoint for any DIRECT row-set mutation (everything that is not
  // a `BlockOp`). Snapshot the current rows, apply `transform` to the whole array,
  // diff into a minimal forward/reverse patch pair, optionally `record` it on the
  // unified stack, then dispatch the forward patch through the SAME
  // optimistic-patch pipeline as structural ops. `diffBlocks`/`patchesFromDiff`
  // already operate over the whole array, so widening the chokepoint from one row
  // to the row SET preserves the property verbatim: forward apply and undo/redo
  // stay symmetric by construction, and a no-op diff records and dispatches
  // nothing.
  //
  // Every such writer funnels through here — `projectText`, the block API's
  // `update`/`setExpanded`, and `convertTo` in BOTH of its shapes (a plain type
  // swap, and the `wrapOnConvert` wrap, which mints the container row and
  // reparents the origin in ONE patch, hence ONE undo entry).
  //
  // Undo/redo restore focus to `focusId`. `coalesceKey` merges run-together
  // edits into one undo step; `record: false` keeps a mutation off the stack
  // (view state) while still flowing it through the optimistic pipeline.
  const commitRows = useCallback(
    (
      transform: (rows: Block[]) => Block[],
      opts: {
        label: string;
        /** Block to re-focus on undo/redo; null when no row owns the caret. */
        focusId: string | null;
        coalesceKey?: string;
        record?: boolean;
      },
    ) => {
      // The patch is FIELD-SCOPED: `transform` produces whole rows, but the
      // diff reduces them to the fields that actually changed, so a text writer
      // never authors `type` and cannot clobber a concurrent conversion. That is
      // the structural half of the fix. RENDER-FRESH rows (not `rowsRef`, which a
      // consumer effect sets, so it lags within a commit) are the belt: the case
      // that proved both is a conversion into a type with its own dispatch
      // component (quote/prompt), which unmounts the text editor, whose
      // projection flush fires from the unmount cleanup — BEFORE the effect
      // refreshes `rowsRef`.
      const before = liveRowsRef.current;
      // Conform only rows this write AUTHORED. `after` is the WHOLE row set —
      // over the composite host, the union of several pages — and every writer
      // here returns `b` unchanged for rows it did not touch, so identity is an
      // exact test. Conforming the rest would sweep an unrelated row into this
      // write's patch under this write's undo label, or (for `setExpanded`,
      // `record: false`) as an unrecorded, unundoable data write.
      //
      // `after` ONLY. `before` stays untouched, so `patchesFromDiff`'s undo
      // update restores the pre-conversion row WITH its `text`. Conforming
      // `before` too — or conforming inside `diffBlocks` — would make undo of a
      // text-to-void conversion restore a text row with no `text`, which the
      // write boundary rejects just as loudly in the other direction.
      const byId = new Map(before.map((b) => [b.id, b]));
      const after = transform(before).map((row) =>
        byId.get(row.id) === row ? row : conformRowText(row),
      );
      const { redo: redoPatch } = patchesFromDiff(diffBlocks(before, after));
      if (isEmptyPatch(redoPatch)) return;
      // A direct row write is held to the zoom like an op is: a `wrapOnConvert`
      // conversion of the root would reparent it under a fresh container,
      // outside the view.
      if (!admitsRows(before, after)) return;
      advanceRows(after);
      // A coalescing entry gets no id: a later write merges INTO an earlier
      // entry, and one rejection must not drop the steps that did land.
      const id =
        opts.record !== false && opts.coalesceKey === undefined
          ? newHistoryEntryId()
          : undefined;
      if (opts.record !== false) {
        recordEntry({
          label: opts.label,
          focusId: opts.focusId,
          coalesceKey: opts.coalesceKey,
          before,
          after,
          id,
        });
      }
      dispatchPatch(redoPatch, id ? dropRejectedEntry(id) : undefined);
    },
    [
      recordEntry,
      dispatchPatch,
      dropRejectedEntry,
      liveRowsRef,
      advanceRows,
      conformRowText,
      admitsRows,
    ],
  );

  // The one-row case of `commitRows`: rewrite exactly the target row and land
  // undo/redo focus on it.
  const commitRow = useCallback(
    (
      blockId: string,
      transform: (b: Block) => Block,
      opts: {
        label: string;
        coalesceKey?: string;
        record?: boolean;
      },
    ) => {
      commitRows(
        (rows) => rows.map((b) => (b.id === blockId ? transform(b) : b)),
        {
          ...opts,
          focusId: blockId,
        },
      );
    },
    [commitRows],
  );

  // `content doc → data.text` projection write (see the interface doc). NEVER
  // recorded: text history is the run tracker's data entries (`recordTextEdit`),
  // so a projection landing on the undo stack would double-count it. Still flows through the shared optimistic
  // patch pipeline (server write + `blocksChanged` fan-out) and no-ops when
  // the row is unchanged or gone.
  const projectText = useCallback<ProjectTextFn>(
    (blockId, runs) => {
      // Existence gate against the RENDER-FRESH rows, not `rowsRef` (Stage 3b
      // fix): the projection's unmount flush fires while a structural patch
      // that deleted this block is committing — `rowsRef` still lists the row
      // at that instant, and projecting through it would UPSERT (resurrect)
      // the just-deleted block. `liveRowsRef` already reflects the deletion.
      if (!liveRowsRef.current.some((b) => b.id === blockId)) return;
      // The gate above can't cover the window where the row was deleted
      // SERVER-side (history restore, another tab's delete) but the push hasn't
      // reached this client yet. It doesn't have to: a text projection changes
      // only `data`, so the patch is an UPDATE, and an update never creates —
      // on the client overlay and the server writer alike. A flush landing in
      // that window is skipped instead of resurrecting the row with pre-delete
      // text; the race is closed by the patch's shape, not by a flag.
      commitRow(
        blockId,
        (b) => ({ ...b, data: { ...(b.data ?? {}), text: runs } }),
        { label: "Project text", record: false },
      );
    },
    [commitRow, liveRowsRef],
  );

  // See the interface doc: the ROW half of an edit whose history entry its own
  // surface already recorded. `preserveText` carries the row's `text`
  // projection across untouched, exactly as `update` does.
  const commitRecordedRowData = useCallback(
    (blockId: string, data: RowData) => {
      commitRow(blockId, (b) => ({ ...b, data: preserveText(b.data, data) }), {
        label: "Edit block",
        record: false,
      });
    },
    [commitRow],
  );

  // Apply a single tree op optimistically AND record it for structural undo. The
  // effect is captured from the CURRENT rows (`rowsRef.current`), so chained
  // keystrokes compose; `store.dispatch` overlays the prediction and fires the
  // network call (a synchronous state write in memory). New blocks carry
  // client-minted ids, so callers mint + focus up front. The op's after-state is
  // computed with the SAME pure `applyBlockOp` the server runs, so the recorded
  // diff is exact.
  const dispatchOp = useCallback(
    (op: BlockOp) => {
      const before = rowsRef.current;
      const { after, written, vars } = predictOp(op, before, opCtx);
      // An op the reducer fully refused (Tab on a first child, Shift+Tab at top
      // level, a bulk indent whose whole run is blocked) wrote no row. Drop it
      // here rather than dispatching: an empty-effect overlay would read as
      // already-absorbed to the apply-guard, and an empty patch pair would put a
      // do-nothing entry on the undo stack. `written`, not `vars.targets`: the
      // latter also carries the rows the op merely NAMES, so it is never empty.
      if (written.length === 0) return;
      // The zoom's refusal, for the same reason and in the same place: an op
      // that would write outside the view never reaches the undo stack, the
      // overlay or the network.
      if (!admitsRows(before, after)) return;
      advanceRows(after);
      const id = newHistoryEntryId();
      recordStructural(
        before,
        after,
        OP_LABELS[op.kind],
        opFocusId(op, before, opCtx),
        id,
      );
      store.dispatch(vars, dropRejectedEntry(id));
    },
    [
      store,
      recordStructural,
      dropRejectedEntry,
      opCtx,
      advanceRows,
      admitsRows,
    ],
  );

  // See the context field. `liveRowsRef`, not `rowsRef`: an affordance asks
  // during RENDER, before the consumer effect that refreshes `rowsRef` has run.
  const admits = useCallback(
    (op: BlockOp): boolean => {
      const before = liveRowsRef.current;
      const { after, written } = predictOp(op, before, opCtx);
      return written.length > 0 && admitsRows(before, after);
    },
    [liveRowsRef, opCtx, admitsRows],
  );

  // The three drag/selection writers are ORDINARY OPS, which is the whole point:
  // each is a `BlockOp` dispatched through `dispatchOp`, so it gets the
  // optimistic overlay, the undo entry, the empty-diff drop and — the reason
  // this stage exists — a place in the page's ordered write stream. Each used to
  // be a bespoke fire-and-forget POST outside all four.
  //
  // MUST stay below `dispatchOp` — they close over it, like `paste`.

  const bulkDelete = useCallback(
    (ids: string[]) => {
      const blockIds = withoutScopeRoot(ids);
      if (blockIds.length === 0) return;
      // ONE op, so one gesture is one undo entry and one server transaction
      // however many roots it names — never N single deletes.
      dispatchOp({ kind: "delete", blockIds });
    },
    [dispatchOp, withoutScopeRoot],
  );

  const bulkMove = useCallback(
    (args: {
      ids: string[];
      parentId: string | null;
      afterId: string | null;
    }) => {
      if (args.ids.length === 0) return;
      dispatchOp({ kind: "bulkMove", ...args });
    },
    [dispatchOp],
  );

  const move = useCallback(
    (id: string, zone: "before" | "after", targetId: string) => {
      // POSITIONAL intent only. `resolveDropParent` is the rank-FREE half of
      // `computeDrop` on purpose: the op carries `(parentId, targetId, zone)` and
      // each side mints its own key from its own sibling set (see
      // `positionalRank`), so there is no rank for this layer to predict — and a
      // drop that changes nothing is dropped by `dispatchOp`'s empty-diff rule
      // rather than by a hand-rolled same-position check.
      const dest = resolveDropParent(rowsRef.current, id, zone, targetId);
      if (!dest) return;
      dispatchOp({
        kind: "move",
        blockId: id,
        parentId: dest.parentId,
        targetId,
        zone,
      });
    },
    [dispatchOp],
  );

  // The identity half every forest insert shares — `paste` and `splice` alike,
  // so the cut-sub-page rule cannot differ between them. Ids are minted HERE,
  // client-side, and travel on the node: the overlay renders the pasted blocks
  // on the keystroke and the server push is a confirmation rather than the
  // first time the user sees their content (see the "Paste is an op" section
  // of this plugin's CLAUDE.md). A cut sub-page's first paste keeps its id —
  // the server then MOVES that page rather than copying it (`PageSource`);
  // everything else is minted.
  const prepareForest = useCallback(
    (blocks: SerializedBlock[]): IdentifiedBlock[] => {
      const forest = withPasteIds(
        blocks,
        claimCutPages(new Set(rowsRef.current.map((b) => b.id))),
      );
      if (forest.length > 0) markCutsPasted(pageSourcesOf(blocks));
      return forest;
    },
    [],
  );

  // Paste a serialized forest — a plain `dispatchOp`, which is the whole point:
  // a paste is a `BlockOp` like any other structural edit, so routing it here
  // (rather than at the store seam, where it used to sit) is what puts it on the
  // undo stack, drops a refused paste before the network, and keeps ONE place
  // that records structural mutations.
  //
  // MUST stay below `dispatchOp` — it closes over it.
  const paste = useCallback(
    (args: {
      blocks: SerializedBlock[];
      afterId: string | null;
      parentId?: string | null;
    }) => {
      const forest = prepareForest(args.blocks);
      if (forest.length === 0) return;
      // Anchored ON the zoom root, a paste would land after it — outside the
      // view — so it lands at the START of the root's children instead, which
      // is where "right below this line" is inside a zoom (anchorless paste
      // inserts at the start of `parentId`).
      if (args.afterId !== null && args.afterId === scope.rootId) {
        dispatchOp({
          kind: "paste",
          forest,
          afterId: null,
          parentId: scope.rootId,
        });
        return;
      }
      // `parentId` defaults to the content top level (`contentParentId`), not
      // null: the reducer's forest excludes the page row, so the page id is how
      // "the content top level" is addressed (see the `paste` op's `parentId`
      // doc) — and inside a zoom the top level is the root.
      dispatchOp({
        kind: "paste",
        forest,
        afterId: args.afterId,
        parentId: args.parentId ?? scope.contentParentId,
      });
    },
    [dispatchOp, scope, prepareForest],
  );

  // Splice a forest into a block's text at an insertion point (see the context
  // field, and `planSplice` for the rule). Split and paste fused, so it takes
  // split's executor shape: the structural op is dispatched synchronously (so
  // the caret can claim the line it lands on in this same turn, ahead of the
  // commit that mounts it), and the ORIGIN's live doc — which ignores rows — is
  // brought to the text the reducer left on its row one microtask later,
  // inside the owner's `untracked` scope, and recorded as data on the SAME
  // entry. One Cmd+Z therefore removes the pasted blocks and restores the
  // origin's full text together.
  //
  // MUST stay below `dispatchOp`'s helpers — it closes over them.
  //
  // The op is planned by `planSpliceOn` — against the CURRENT rows here, and
  // against what a span delete leaves in `replaceSpan` — so the tail's type and
  // data are resolved in one place for both.
  const planSpliceOn = useCallback(
    (base: Block[], args: SpliceArgs) => {
      const origin = base.find((b) => b.id === args.blockId);
      if (!origin) return null;
      const forest = prepareForest(args.blocks);
      if (forest.length === 0) return null;
      // The tail's type and data, resolved HERE where block handles are
      // visible — split's `siblingType` / `tailData` rule, read off the same
      // handle fields the keystroke resolver reads (`splitInto`,
      // `dataOnSplit`), and guarded to the same-type case for the same reason:
      // running the origin's transform on a tail validated against a different
      // schema would corrupt it.
      const handle = blockHandles.get(origin.type);
      const siblingType = handle?.splitInto;
      const tailData =
        handle?.dataOnSplit && (siblingType ?? origin.type) === origin.type
          ? handle.dataOnSplit(origin.data)
          : undefined;
      const op: Extract<BlockOp, { kind: "splice" }> = {
        kind: "splice",
        blockId: args.blockId,
        position: args.position,
        runs: args.runs,
        forest,
        granularity: args.granularity,
        tailId: newBlockId(),
        siblingType,
        tailData,
      };
      const plan = planSplice(toNodes(base), op, opCtx);
      return plan ? { op, plan } : null;
    },
    [prepareForest, blockHandles, opCtx],
  );

  const splice = useCallback(
    (args: SpliceArgs) => {
      // The zoom root's next siblings are outside the view, so a splice there
      // would be refused whole by the backstop. It keeps the root's own rule
      // instead — the forest lands as the root's first children, the text
      // stays where it is — rather than dropping the user's paste on the floor.
      if (args.blockId === scope.rootId) {
        paste({ blocks: args.blocks, afterId: args.blockId });
        return;
      }
      const before = rowsRef.current;
      const planned = planSpliceOn(before, args);
      if (!planned) return;
      const { op, plan } = planned;
      const { caret } = plan;
      const beforeIds = new Set(before.map((b) => b.id));
      const originRow = plan.blocks.find((b) => b.id === args.blockId);

      // A single-paragraph paste creates no row: it is a TEXT edit of the
      // origin, and a text edit is a doc edit. Rows never carry an existing
      // block's text (it is doc-owned; `data.text` is a projection), so it is
      // recorded as the one data entry `recordDocEdit` makes, and the caret is
      // placed after it lands (queued behind its microtask).
      if (originRow && plan.blocks.every((b) => beforeIds.has(b.id))) {
        const target = runsOfNode(originRow);
        recordDocEdit(args.blockId, OP_LABELS.splice, () =>
          spliceOpenBlockDoc(spliceOwnerOf(args.blockId), target),
        );
        queueMicrotask(() => focusBlock(caret.blockId, caret.offset));
        return;
      }

      const { after, written, vars } = predictOp(op, before, opCtx);
      if (written.length === 0) return;
      if (!admitsRows(before, after)) return;
      advanceRows(after);
      const entryId = newHistoryEntryId();
      store.dispatch(vars, dropRejectedEntry(entryId));
      // The line the caret lands on is always one this op CREATED (the last
      // pasted line, or the minted tail), so this claims the keyboard until it
      // mounts — split's `focusNew`, at an offset.
      focusBlock(caret.blockId, caret.offset, { scroll: true });

      // Deferred for split's reason: this runs from a Lexical command handler,
      // i.e. INSIDE the origin editor's own update, where a nested update would
      // commit only after the `untracked` scope closed. A CONSUMED origin (an
      // empty paragraph the forest replaced) has no text to edit: its row is
      // gone, and its doc — untouched — is what undo binds the restored row to.
      queueMicrotask(() => {
        if (!originRow) {
          recordEntry({
            label: OP_LABELS.splice,
            focusId: caret.blockId,
            before,
            after,
            id: entryId,
          });
          return;
        }
        const target = runsOfNode(originRow);
        const owner = spliceOwnerOf(args.blockId);
        const originBefore = owner.runsNow();
        owner.untracked(() => spliceOpenBlockDoc(owner, target));
        recordEntry({
          label: OP_LABELS.splice,
          focusId: caret.blockId,
          before,
          after,
          id: entryId,
          runsEdits: runsEqual(originBefore, target)
            ? []
            : [{ blockId: args.blockId, before: originBefore, after: target }],
        });
      });
    },
    [
      scope,
      paste,
      planSpliceOn,
      opCtx,
      recordDocEdit,
      focusBlock,
      admitsRows,
      advanceRows,
      store,
      dropRejectedEntry,
      recordEntry,
    ],
  );

  // See the context field: `splice`'s two inputs, read from a pointer position
  // off the block's own text surface. Reached through `surgeryOf` like every
  // other content read, so nothing here can place a caret.
  const insertionPointAt = useCallback(
    (
      blockId: string,
      x: number,
      y: number,
    ): { position: number; runs: RichText } | null => {
      const surgery = authority.surgeryOf(blockId);
      if (!surgery?.offsetAtPoint || !surgery.readRuns) return null;
      const position = surgery.offsetAtPoint(x, y);
      if (position === null) return null;
      return { position, runs: surgery.readRuns() };
    },
    [authority],
  );

  // Duplicate a selection — one `dispatchOp` for the whole gesture, for paste's
  // reasons: it is what puts the clones on the undo stack as ONE entry and what
  // makes them render on the click rather than after the round-trip. Ids are
  // minted HERE, client-side, which is exactly what the old server-minting path
  // could not offer (no client-computed after-state to invert).
  //
  // MUST stay below `dispatchOp` — it closes over it.
  const bulkDuplicate = useCallback(
    (selected: string[]) => {
      const ids = withoutScopeRoot(selected);
      if (ids.length === 0) return;
      const before = rowsRef.current;
      // Document-ordered for determinism and to match every other
      // selection-driven op (the folds, `pasteAnchorId`) — `blockSelectionRoots`
      // preserves input-ARRAY order, which is nobody's order. Not load-bearing
      // for agreement: the array travels on the op, so both sides fold it
      // identically.
      const nodes = toNodes(before);
      const roots = inDocumentOrder(
        nodes,
        blockSelectionRoots(nodes, new Set(ids), isAnchorNode),
      );
      if (roots.length === 0) return;
      // One `serializeForest` call PER root, not one zipped call: a filtered
      // positional array is exactly the silent-desync hazard the paste op's
      // "ids ride the node" rule exists to prevent.
      dispatchOp({
        kind: "duplicate",
        placements: roots.map((id) => ({
          afterId: id,
          forest: withMintedIds(serializeForest(before, [id])),
        })),
      });
    },
    [dispatchOp, isAnchorNode, withoutScopeRoot],
  );

  // Indent / outdent a SET of blocks (the selection roots). The single-block Tab
  // in a text editor is the one-element case, routed through the same op — see
  // `foldIndent`/`foldOutdent` for why a set moves as one rigid body.
  const indentBlocks = useCallback(
    (blockIds: string[]) => {
      if (blockIds.length > 0) dispatchOp({ kind: "indent", blockIds });
    },
    [dispatchOp],
  );

  const outdentBlocks = useCallback(
    (blockIds: string[]) => {
      if (blockIds.length > 0) dispatchOp({ kind: "outdent", blockIds });
    },
    [dispatchOp],
  );

  // Dissolve a container in place (see the context field's doc). A plain
  // `dispatchOp`, so it is optimistic, recorded as one undo entry, and refused as
  // a no-op when `blockId` is gone or is a page row.
  const unwrapBlock = useCallback(
    (blockId: string) => {
      dispatchOp({ kind: "unwrap", blockId });
    },
    [dispatchOp],
  );

  // Overlay-dispatch triplet shared by the split / offscreen-merge executors:
  // snapshot the current rows, compute the after-state with the SAME pure
  // `applyBlockOp` the store applies, dispatch through the store (instant
  // prediction + network call on the server path; a synchronous authoritative
  // write in memory), and return both snapshots for the combined record.
  // NOT used by the mounted-merge site, whose dispatch is deliberately deferred
  // into a microtask after the append lands (see the merge executor, issue #7).
  //
  // `null` when the zoom refuses the op: nothing was dispatched, and the caller
  // must not go on to the content-doc half of its gesture (a split's
  // truncation, a merge's record) — the rows it would describe never changed.
  const applyOverlay = useCallback(
    (
      op: BlockOp,
    ): { before: Block[]; after: Block[]; entryId: string } | null => {
      const before = rowsRef.current;
      const { after, vars } = predictOp(op, before, opCtx);
      if (!admitsRows(before, after)) return null;
      advanceRows(after);
      // The caller records the entry under this id (see `RecordEntryArgs.id`).
      const entryId = newHistoryEntryId();
      store.dispatch(vars, dropRejectedEntry(entryId));
      return { before, after, entryId };
    },
    [store, dropRejectedEntry, opCtx, advanceRows, admitsRows],
  );

  // Move the caret into a freshly-minted block by its known id. The block does
  // not exist yet — this runs in the same turn as the op that creates it — so
  // the authority CLAIMS the caret: it takes the keyboard and buffers what the
  // user types until the new editor's caret is ready. That claim is the whole
  // fix; without it every keystroke in the mount gap went to the origin block.
  const focusNew = useCallback(
    (id: string) => {
      // A freshly-created block (Enter / split / insert) is a scroll-wanted
      // landing: the new block may be below the fold, so reveal it.
      authority.land(id, (handle, land) =>
        handle.focus({ scroll: true, ...land }),
      );
    },
    [authority],
  );

  // Insert a new block at the end of the view. Top-level page content is
  // parented to the page block (`parentId: pageId`), since `computePageId(null)`
  // is null — and inside a zoom the top level is the root, so the new block is
  // its last child (`contentParentId`). Omitting `afterId` lets the reducer
  // append it after the last existing sibling. The id is minted up front so
  // focus does not wait on the server round-trip.
  const insert = useCallback(
    (type: string, data: unknown) => {
      const newId = newBlockId();
      focusNew(newId);
      dispatchOp({
        kind: "insert",
        newId,
        type,
        data,
        parentId: scope.contentParentId,
      });
    },
    [scope, dispatchOp, focusNew],
  );

  // Insert a new block at the TOP of the view, before the current first
  // top-level block (`beforeId` — the reducer ranks it ahead of that sibling);
  // inside a zoom, as the root's first child. An empty view has no such
  // sibling, so it falls back to the plain parent-append, equivalent there.
  const insertFirst = useCallback(
    (type: string, data: unknown) => {
      const newId = newBlockId();
      focusNew(newId);
      dispatchOp({
        kind: "insert",
        newId,
        type,
        data,
        ...firstUnder(scope.contentParentId),
      });
    },
    [scope, dispatchOp, focusNew, firstUnder],
  );

  // The `wrapOnConvert` half of `convertTo`: mint a container row of `type` and
  // make `blockId` its FIRST CHILD, in ONE patch through the shared row-set
  // chokepoint — hence ONE undo entry, and the reducer's childless-anchor prune
  // is never observed mid-flight (there is no intermediate state where the
  // container exists without its child).
  //
  // The ORIGIN keeps its id, type, `data` (its `text` projection included, since
  // its content doc is untouched), children and rank. Keeping the id is
  // load-bearing, not an optimization: its `page_block_docs` Yjs doc, its
  // content owner and its registered `BlockFocusHandle` are all keyed by block
  // id, so the caret simply stays put — no `focusNew`, no remount race. The NEW
  // id goes to the container, which is void and never opens a content doc, so
  // the doc-init FK gate applies to neither row.
  //
  // The container takes a FRESH rank strictly before the origin's, never the
  // origin's own: reusing it would need the ranks to be parked (two rows briefly
  // sharing one `(parent_id, rank)` slot), and the in-memory store has no
  // `parkRanks` — it applies the patch verbatim.
  const wrapInContainer = useCallback(
    (blockId: string, type: string, containerData: unknown) => {
      const containerId = newBlockId();
      commitRows(
        (rows) => {
          const origin = rows.find((b) => b.id === blockId);
          if (!origin) return rows;
          const nodes = toNodes(rows);
          const siblings = childrenOf(nodes, origin.parentId);
          const index = siblings.findIndex((s) => s.id === origin.id);
          const prev = index > 0 ? siblings[index - 1] : undefined;
          const container: Block = {
            id: containerId,
            pageId: origin.pageId,
            parentId: origin.parentId,
            type,
            data: containerData,
            // Born expanded, like every other created row: a container's stored
            // `expanded` is LIVE (it folds to its borrowed line), so a wrap that
            // minted `false` would hand the user a box that arrives folded.
            expanded: true,
            rank: Rank.between(
              prev ? Rank.from(prev.rank) : null,
              Rank.from(String(origin.rank)),
            ),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          return [
            ...rows.map((b) =>
              b.id === blockId ? { ...b, parentId: containerId } : b,
            ),
            container,
          ];
        },
        { label: "Wrap in container", focusId: blockId },
      );
    },
    [commitRows],
  );

  // Merge `sourceId`'s content + subtree into the previous VISIBLE line and
  // delete it — the shared core of Backspace-at-start (`merge`, source = this
  // block) and Delete-at-end (`mergeNext`, source = the NEXT visible line).
  // `runs` is the source's authoritative live runs (undefined ⇒ the reducer
  // falls back to the stored projection). The reducer merges into
  // `prevVisibleLine(source)`, so we resolve the same target here to land the
  // caret at the JOIN offset (the target's text length BEFORE the append) and
  // drive the target's bound editor. Both source blocks flow through ONE
  // implementation, so the microtask-deferred append-first ordering and the
  // combined data entry are reused unchanged.
  const mergeBlock = useCallback(
    (sourceId: string, runs?: RichText) => {
      const nodes = toNodes(rowsRef.current);
      const block = nodes.find((b) => b.id === sourceId);
      if (!block) return;
      const target = prevVisibleLine(nodes, block, isAnchorNode);
      if (!target) return; // defensive: nothing to merge into
      // Composite-union backstop: merge is strictly in-page. Over the union the
      // previous visible line can belong to ANOTHER page (the line above an
      // expanded sub-page's first block, or below its last); the keystroke
      // resolver already guards the boundary, so a cross-page source/target
      // pair here is a stray call — bail rather than splice text across two
      // pages' stores.
      if (target.pageId !== block.pageId) return;
      // The reducer's row-level text concatenation is ignored by bound
      // editors — the merging block's LIVE runs (may contain unflushed
      // edits) must land in the TARGET's content doc too. Both variants
      // record ONE combined entry: the structural patch plus a runs edit on
      // the target (`targetBefore` → `targetAfter`), so a single Cmd+Z
      // restores this block's row AND un-appends the target's doc together.
      // The restored source row's `data.text` is pinned to its doc's runs by
      // `derivePatchEntry` (the delete is a trash, so the source doc normally
      // SURVIVES and undo binds back to it — but the row's text is what
      // history, search and backlinks read, and what seeds the doc when it did
      // not survive, so it must be exactly what was merged away).
      const mergingRuns = runs ?? runsOfNode(block);
      const targetHandle = authority.surgeryOf(target.id);
      const op: BlockOp = { kind: "merge", blockId: sourceId, runs };
      // Both branches append the source's text into the target's DOC before the
      // structural delete, so the zoom has to be asked FIRST: a refusal found
      // only at dispatch time would leave the text appended to the target while
      // the source row — still holding it — stays.
      const before = rowsRef.current;
      const { after, vars } = predictOp(op, before, opCtx);
      if (!admitsRows(before, after)) return;
      if (targetHandle?.appendRunsAtEnd) {
        // Mounted target: drive its bound editor (append + caret at the live
        // join). Append-FIRST ordering (issue #7): the append rides a microtask
        // (deferred so the current keydown can't act on the newly-focused
        // block), and the structural delete overlay is dispatched only AFTER the
        // append lands — so a throwing append leaves BOTH blocks intact (a loud
        // unhandled rejection, overlay never dispatched), matching the offscreen
        // branch's guarantee, instead of removing the source row with its text
        // un-transferred. `before`/`after` are captured up front so they snapshot
        // the pre-merge rows; the dispatch is kept explicit here (not
        // `applyOverlay`) precisely because its ordering is deferred.
        const append = targetHandle.appendRunsAtEnd;
        queueMicrotask(() => {
          // The target's runs before the append come from its DOC (the
          // authority, memoized), never from its ~1 s-lagged row. The append
          // runs inside `untracked` (surgery uses `discrete: true`, so the
          // binding's transaction lands synchronously inside the scope): the
          // run tracker must not ALSO record it as typing on top of this
          // entry. A throw propagates out of the microtask BEFORE the
          // dispatch — the source row is never removed.
          const targetOwner = blockDocOwnerOf(target.id);
          const targetBefore = targetOwner
            ? targetOwner.runsNow()
            : runsOfNode(target);
          const targetAfter = mergeRuns(targetBefore, mergingRuns);
          if (targetOwner) targetOwner.untracked(() => append(mergingRuns));
          else append(mergingRuns);
          const entryId = newHistoryEntryId();
          store.dispatch(vars, dropRejectedEntry(entryId));
          recordEntry({
            label: OP_LABELS.merge,
            focusId: sourceId,
            before,
            after,
            id: entryId,
            runsEdits: [
              { blockId: target.id, before: targetBefore, after: targetAfter },
            ],
          });
        });
      } else {
        // Unmounted target (virtualized offscreen): lossless doc-level
        // append FIRST, structural delete only after it lands — a failed
        // append leaves both blocks intact (loud unhandled rejection)
        // instead of orphaning the text in a row the target's doc would
        // later overwrite via projection. No caret to place: the target
        // has no editor. The append goes through the stored-doc replay
        // host (`spliceStoredBlockDoc`), RELATIVE to the authoritative runs
        // the server holds — never to the row's lagged projection — and
        // hands back what it read and wrote, which IS the entry's runs edit:
        // undo splices the target back to `targetBefore` (the prefix
        // alignment removes exactly the appended suffix), redo brings it to
        // `targetAfter` again. The target's `data.text` is read at write time
        // (doc-init seeds from it only if no doc exists — a never-opened
        // block).
        const targetId = target.id;
        const targetDataText = () =>
          runsOfNode(rowsRef.current.find((b) => b.id === targetId) ?? target);
        void spliceStoredBlockDoc(targetId, targetDataText(), (current) =>
          mergeRuns(current, mergingRuns),
        ).then(({ before: targetBefore, after: targetAfter }) => {
          const applied = applyOverlay(op);
          // Admitted above, against the rows of that turn. A refusal now means
          // the page moved under the round trip; the append has landed and its
          // runs edit is real, so it is recorded as the text entry it is.
          if (!applied) {
            recordTextEdit({
              blockId: targetId,
              before: targetBefore,
              after: targetAfter,
            });
            return;
          }
          recordEntry({
            label: OP_LABELS.merge,
            focusId: sourceId,
            // The rows `applyOverlay` really diffed, which may be later than
            // the admission's snapshot above: the append was a round trip.
            before: applied.before,
            after: applied.after,
            id: applied.entryId,
            runsEdits: [
              { blockId: targetId, before: targetBefore, after: targetAfter },
            ],
          });
        });
      }
    },
    [
      store,
      dropRejectedEntry,
      applyOverlay,
      recordEntry,
      recordTextEdit,
      opCtx,
      isAnchorNode,
      authority,
      admitsRows,
    ],
  );

  // ---- Editor-owned text span: delete / type over / paste over ------------
  //
  // The live runs of a span END. `normalizeSpan` only makes a span over lines
  // whose text surface is mounted (`textReadsOf`), so a missing one is a broken
  // invariant, never a case to route around.
  const spanEndRuns = useCallback(
    (id: string): RichText => {
      const read = authority.surgeryOf(id)?.readRuns;
      if (!read) {
        throw new Error(
          `text span: block "${id}" has no mounted text surface to read`,
        );
      }
      return read();
    },
    [authority],
  );

  // Land the caret at a span's join — plainly, or replaying the keys that
  // replaced the span (`landWithInput`: a flight whose buffer starts with them,
  // so everything typed before the landing queues behind them). Queued one
  // microtask, behind the binding's relay of the doc splice that made the
  // join, so the offset resolves against the joined text.
  const landAtJoin = useCallback(
    (blockId: string, offset: number, input?: readonly FlightInput[]) => {
      queueMicrotask(() => {
        if (!input || input.length === 0) {
          focusBlock(blockId, offset);
          return;
        }
        authority.landWithInput(
          blockId,
          (handle, land) => {
            if (handle.focusOffset) handle.focusOffset(offset, land);
            else handle.focus(land);
          },
          input,
        );
      });
    },
    [authority, focusBlock],
  );

  // The span's text edit: the start line's content becomes `runs` (its head,
  // whatever replaces the span, the end line's tail) and — across blocks — the
  // lines after it up to the end line go, as ONE `deleteSpan` op. Modelled on
  // `mergeBlock`: the doc half lands FIRST, inside the owner's `untracked`
  // scope, and the op is dispatched only once it has, so a throwing splice
  // leaves every line intact. ONE entry: the patch pair plus the start line's
  // runs edit, so one Cmd+Z restores the removed lines (their docs survive the
  // trash) AND the start line's text. Inside one block it is that runs edit
  // alone. Never inside a Lexical command (the container's keydown and
  // clipboard handlers issue it), so nothing defers the doc splice.
  //
  // False when the reducer refuses the op (the forest moved under the span):
  // nothing changed, nothing was recorded.
  const commitSpanEdit = useCallback(
    (from: SpanPoint, to: SpanPoint, runs: RichText, label: string) => {
      const owner = spliceOwnerOf(from.blockId);
      const fromBefore = owner.runsNow();
      const before = rowsRef.current;
      const runsEdits = runsEqual(fromBefore, runs)
        ? []
        : [{ blockId: from.blockId, before: fromBefore, after: runs }];
      if (from.blockId === to.blockId) {
        if (runsEdits.length === 0) return true;
        owner.untracked(() => spliceOpenBlockDoc(owner, runs));
        recordEntry({
          label,
          focusId: from.blockId,
          before,
          after: before,
          runsEdits,
        });
        return true;
      }
      const op: BlockOp = {
        kind: "deleteSpan",
        targetId: from.blockId,
        sourceId: to.blockId,
        runs,
      };
      const { after, written, vars } = predictOp(op, before, opCtx);
      if (written.length === 0) return false;
      if (!admitsRows(before, after)) return false;
      owner.untracked(() => spliceOpenBlockDoc(owner, runs));
      advanceRows(after);
      const entryId = newHistoryEntryId();
      store.dispatch(vars, dropRejectedEntry(entryId));
      recordEntry({
        label,
        focusId: from.blockId,
        before,
        after,
        id: entryId,
        runsEdits,
      });
      return true;
    },
    [opCtx, admitsRows, advanceRows, store, dropRejectedEntry, recordEntry],
  );

  // Enter over a span: the span deleted and the join line split there, as
  // ONE entry — the `deleteSpan` op (across blocks) then the `split` op,
  // both predicted before either is dispatched, `replaceSpan`'s shape. The
  // split is the one a caret at the join would make (`enterReplacingIntent`,
  // resolved against the rows the delete leaves), so the tail's type, data and
  // nesting are Enter's own. Replaying the key at the join instead made it a
  // second entry: one Cmd+Z put the line break back and left the span deleted.
  const breakSpan = useCallback(
    (from: SpanPoint, to: SpanPoint): boolean => {
      const fromRuns = spanEndRuns(from.blockId);
      const joinAt = Math.min(from.offset, runsLength(fromRuns));
      const toRuns =
        from.blockId === to.blockId ? fromRuns : spanEndRuns(to.blockId);
      const joined = joinAroundSpan(fromRuns, from.offset, toRuns, to.offset);
      const before = rowsRef.current;
      let first: ReturnType<typeof predictOp> | null = null;
      if (from.blockId !== to.blockId) {
        first = predictOp(
          {
            kind: "deleteSpan",
            targetId: from.blockId,
            sourceId: to.blockId,
            runs: joined,
          },
          before,
          opCtx,
        );
        if (first.written.length === 0) return false;
      }
      const base = first?.after ?? before;
      const nodes = toNodes(base);
      const intent = enterReplacingIntent(
        intentContextOf(
          scope.rootId === null ? nodes : scopeNodes(nodes, scope.rootId),
          from.blockId,
          scope.rootId,
          (type) => blockHandles.get(type),
        ),
        joinAt,
        runsLength(joined),
      );
      if (!intent) return false;
      const newId = newBlockId();
      const second = predictOp(
        {
          kind: "split",
          blockId: from.blockId,
          position: joinAt,
          newId,
          asChild: intent.asChild,
          childType: intent.childType,
          siblingType: intent.siblingType,
          tailData: intent.tailData,
          runs: joined,
        },
        base,
        opCtx,
      );
      if (second.written.length === 0) return false;
      if (!admitsRows(before, second.after)) return false;
      // The join line's doc ends as the split leaves its row: the head, or —
      // the split at the START of a non-empty line, which mints the empty
      // line ABOVE and keeps the origin — the whole joined text.
      const keepsOrigin =
        !intent.asChild && joinAt === 0 && runsLength(joined) > 0;
      const target = keepsOrigin ? joined : splitRuns(joined, joinAt)[0];
      const owner = spliceOwnerOf(from.blockId);
      const fromBefore = owner.runsNow();
      owner.untracked(() => spliceOpenBlockDoc(owner, target));
      advanceRows(second.after);
      const entryId = newHistoryEntryId();
      if (first) store.dispatch(first.vars, dropRejectedEntry(entryId));
      store.dispatch(second.vars, dropRejectedEntry(entryId));
      // Enter at a line's start keeps the caret where it is; any other lands
      // it on the new line — which does not exist yet, so the landing claims.
      const caretId = keepsOrigin ? from.blockId : newId;
      focusBlock(caretId, 0, { scroll: true });
      recordEntry({
        label: OP_LABELS.split,
        focusId: caretId,
        before,
        after: second.after,
        id: entryId,
        runsEdits: runsEqual(fromBefore, target)
          ? []
          : [{ blockId: from.blockId, before: fromBefore, after: target }],
      });
      return true;
    },
    [
      spanEndRuns,
      opCtx,
      scope,
      blockHandles,
      admitsRows,
      advanceRows,
      store,
      dropRejectedEntry,
      focusBlock,
      recordEntry,
    ],
  );

  // See the context field.
  const deleteSpan = useCallback(
    (from: SpanPoint, to: SpanPoint, input?: readonly FlightInput[]) => {
      const only = input?.length === 1 ? input[0] : undefined;
      // A plain Enter splits at the join in the same entry (`breakSpan`); a
      // refused one (the forest moved under the span) changes nothing.
      if (only?.kind === "key" && only.key === "Enter" && !only.shift) {
        breakSpan(from, to);
        return;
      }
      const fromRuns = spanEndRuns(from.blockId);
      const joinAt = Math.min(from.offset, runsLength(fromRuns));
      const toRuns =
        from.blockId === to.blockId ? fromRuns : spanEndRuns(to.blockId);
      // A character typed over the span — or Shift+Enter's soft line break,
      // which is a character of the line — is part of the span's own edit.
      const typed =
        only?.kind === "text"
          ? only.text
          : only?.kind === "key" && only.key === "Enter"
            ? "\n"
            : undefined;
      const joined = joinAroundSpan(
        fromRuns,
        from.offset,
        toRuns,
        to.offset,
        typed,
      );
      const label = typed === undefined ? OP_LABELS.deleteSpan : "Type";
      // A refused span changes nothing, and the caret stays where it is.
      if (!commitSpanEdit(from, to, joined, label)) return;
      if (typed !== undefined) landAtJoin(from.blockId, joinAt + typed.length);
      else landAtJoin(from.blockId, joinAt, input);
    },
    [breakSpan, spanEndRuns, commitSpanEdit, landAtJoin],
  );

  // See the context field. The splice is planned against the rows the span's
  // delete LEAVES (both predicted before anything is dispatched), so the two
  // ops reach the store in issue order and fold exactly as predicted — and the
  // entry brackets the whole gesture: before the delete, after the splice.
  const replaceSpan = useCallback(
    (
      from: SpanPoint,
      to: SpanPoint,
      insert: { blocks: SerializedBlock[]; granularity: ForestGranularity },
    ) => {
      const fromRuns = spanEndRuns(from.blockId);
      const joinAt = Math.min(from.offset, runsLength(fromRuns));
      const toRuns =
        from.blockId === to.blockId ? fromRuns : spanEndRuns(to.blockId);
      const joined = joinAroundSpan(fromRuns, from.offset, toRuns, to.offset);
      const args: SpliceArgs = {
        blockId: from.blockId,
        position: joinAt,
        runs: joined,
        ...insert,
      };
      // On the zoom root a splice is a paste BELOW it (its next siblings are
      // outside the view), not one at the join — so the span goes as a step of
      // its own and the paste keeps the root's rule. Two entries; rare.
      if (from.blockId === scope.rootId) {
        if (commitSpanEdit(from, to, joined, OP_LABELS.deleteSpan))
          splice(args);
        return;
      }
      const before = rowsRef.current;
      let first: ReturnType<typeof predictOp> | null = null;
      if (from.blockId !== to.blockId) {
        const del: BlockOp = {
          kind: "deleteSpan",
          targetId: from.blockId,
          sourceId: to.blockId,
          runs: joined,
        };
        first = predictOp(del, before, opCtx);
        if (first.written.length === 0) return;
      }
      const base = first?.after ?? before;
      const planned = planSpliceOn(base, args);
      if (!planned) return;
      const { op, plan } = planned;
      const originRow = plan.blocks.find((b) => b.id === from.blockId);
      const baseIds = new Set(base.map((b) => b.id));

      // A paste that creates no line is a TEXT edit of the join line: the
      // span's own edit with the pasted text in its result — one op at most.
      if (originRow && plan.blocks.every((b) => baseIds.has(b.id))) {
        if (commitSpanEdit(from, to, runsOfNode(originRow), OP_LABELS.splice))
          landAtJoin(plan.caret.blockId, plan.caret.offset);
        return;
      }

      const second = predictOp(op, base, opCtx);
      if (second.written.length === 0) return;
      if (!admitsRows(before, second.after)) return;
      const owner = spliceOwnerOf(from.blockId);
      const fromBefore = owner.runsNow();
      // A CONSUMED join line (an empty plain paragraph the forest replaced)
      // has no text to edit: its row goes, and its doc — untouched — is what
      // undo binds the restored row to.
      const target = originRow ? runsOfNode(originRow) : null;
      if (target) owner.untracked(() => spliceOpenBlockDoc(owner, target));
      advanceRows(second.after);
      const entryId = newHistoryEntryId();
      if (first) store.dispatch(first.vars, dropRejectedEntry(entryId));
      store.dispatch(second.vars, dropRejectedEntry(entryId));
      // The line the caret lands on is one the splice CREATED: a claim.
      focusBlock(plan.caret.blockId, plan.caret.offset, { scroll: true });
      recordEntry({
        label: OP_LABELS.splice,
        focusId: plan.caret.blockId,
        before,
        after: second.after,
        id: entryId,
        runsEdits:
          target === null || runsEqual(fromBefore, target)
            ? []
            : [{ blockId: from.blockId, before: fromBefore, after: target }],
      });
    },
    [
      spanEndRuns,
      scope,
      commitSpanEdit,
      splice,
      opCtx,
      planSpliceOn,
      landAtJoin,
      admitsRows,
      advanceRows,
      store,
      dropRejectedEntry,
      focusBlock,
      recordEntry,
    ],
  );

  // THE row-side half of a type change, shared by `BlockEditorAPI.convertTo` and
  // `convertStrippingText` so the two can never drift. Recorded (a conversion is
  // a document edit) and dispatched through the same optimistic patch pipeline
  // as its own undo/redo; `commitRow` no-ops a missing/unchanged block.
  //
  // The wrap/swap decision lives HERE, not on `convertTo`, precisely because
  // this is the shared half: with it one level up, `convertStrippingText` — the
  // path the `/` menu, the gutter-`+` draft and the markdown shortcuts all take
  // — silently bypassed it, so `/callout` retyped the origin into a container
  // instead of wrapping it (losing its text, and 400ing on the callout's void
  // schema). Every caller reaching a type change must reach this decision.
  const convertRow = useCallback(
    (blockId: string, type: string, data: RowData, expanded?: boolean) => {
      // Converting INTO a `wrapOnConvert` type is a WRAP, not a type swap: mint
      // a container row and make THIS block its first child, keeping this
      // block's id, type, data (text projection included), children and rank.
      // `data` is the CONTAINER's seed on this path, not the origin's — there is
      // no type change to carry a payload for, so the caller's `data` is
      // deliberately ignored in favour of the target's own `empty()`, and
      // `preserveText` has nothing to do here.
      const target = blockHandles.get(type);
      if (target?.wrapOnConvert) {
        wrapInContainer(blockId, type, target.empty?.() ?? {});
        return;
      }
      commitRow(
        blockId,
        (b) => ({
          ...b,
          type,
          data: preserveText(b.data, data),
          expanded: expanded ?? b.expanded,
        }),
        { label: "Change block type" },
      );
    },
    [commitRow, blockHandles, wrapInContainer],
  );

  // The doc half of every text-consuming commit. `deleteRange` is DISCRETE, so
  // its Yjs transaction commits within this task — before React can re-render
  // and move the block (a `wrapOnConvert` target reparents it into a fresh
  // container, which DOES remount its editor). That is the guarantee, not the
  // statement order: called from the slash menu this runs inside the caret
  // menu's own `editor.update()`, where Lexical defers the nested update to the
  // end of the outer one — still ahead of any re-render, which is all that
  // matters.
  //
  // A block with no registered handle (text-less, or not yet mounted) has
  // nothing to strip — an empty span is the normal case here, not a swallowed
  // failure.
  //
  // Reached through the caret authority's `surgeryOf` seam, which hands back
  // content surgery and NOT `focus` — the registry itself is unreachable from
  // here on purpose, so no caller can place a caret behind the authority's back.
  const stripText = useCallback(
    ({ blockId, from, to }: { blockId: string; from: number; to: number }) => {
      authority.surgeryOf(blockId)?.deleteRange?.(from, to);
    },
    [authority],
  );

  const convertStrippingText = useCallback(
    ({
      blockId,
      from,
      to,
      type,
      data,
      expanded,
    }: {
      blockId: string;
      from: number;
      to: number;
      type: string;
      data: RowData;
      expanded?: boolean;
    }) => {
      // (1) The doc — see `stripText`.
      stripText({ blockId, from, to });
      // (2) The row. It states the TYPE and nothing about text: the stripped
      // content reaches `data.text` on its own, through the projection. Strictly
      // AFTER the strip — `/callout` must lose its `/callout` query from the
      // content doc before the block becomes a container's first child.
      convertRow(blockId, type, data, expanded);
    },
    [convertRow, stripText],
  );

  const makeBlockAPI = useCallback(
    (blockId: string): BlockEditorAPI => ({
      update(data: RowData) {
        // The single data-write affordance every block renderer uses — routed
        // through `commitRow` so non-text edits (to-do checked, callout color,
        // image src, …) are optimistic AND recorded. `coalesceKey: blockId`
        // collapses streaming/rapid same-block edits into one undo step. The
        // blob is REPLACED, but `text` is carried across by `preserveText`: a
        // control flipping `checked` must not be able to write a lagged text
        // snapshot back over the row.
        commitRow(
          blockId,
          (b) => ({
            ...b,
            data: preserveText(b.data, data),
          }),
          { label: "Edit block", coalesceKey: blockId },
        );
      },
      setExpanded(expanded: boolean) {
        // Pure view state — deliberately NOT recorded into history (`record: false`):
        // Notion doesn't undo collapse/expand; it's not a document edit. Still flows
        // through the optimistic patch pipeline for snappiness, self-correcting on
        // re-click via the pageBlocks push.
        commitRow(blockId, (b) => ({ ...b, expanded }), {
          label: "Toggle collapse",
          record: false,
        });
      },
      convertTo(type: string, data: RowData, opts?: { expanded?: boolean }) {
        // The plain path, for a type change that touches no text at all. A
        // conversion that CONSUMES some of the block's own text (a `/query`, a
        // markdown prefix) must go through `convertStrippingText` instead.
        //
        // Both land on `convertRow`, which owns the wrap-vs-swap decision — so
        // Turn-into and `url-paste` get `wrapOnConvert` from the same place the
        // slash menu does, rather than from a check only this caller ran.
        convertRow(blockId, type, data, opts?.expanded);
      },
      insertAfter(type: string, data: unknown, opts?: { focus?: boolean }) {
        const newId = newBlockId();
        // `focus: false` is for callers that keep focus elsewhere while acting on
        // the new block (the gutter `+` filter field). Focusing here would race
        // them: `focusNew` also arms a pending focus that fires when the block
        // mounts on the confirming push, stealing focus back after the fact.
        if (opts?.focus !== false) focusNew(newId);
        // "Below" the zoom root is its first child: after it would be outside
        // the view. This is the rail `+`, a void block's Enter and every other
        // "new line below this one" anchored on the root.
        dispatchOp(
          blockId === scope.rootId
            ? { kind: "insert", newId, type, data, ...firstUnder(blockId) }
            : { kind: "insert", newId, type, data, afterId: blockId },
        );
        return newId;
      },
      split(
        position: number,
        opts?: {
          asChild?: boolean;
          childType?: string;
          siblingType?: string;
          tailData?: unknown;
          runs?: RichText;
          deleteTo?: number;
        },
      ) {
        // Thin executor: the asChild decision is owned by `resolveKeystroke`
        // (the single intent step) and passed in explicitly. The new block's id
        // is minted up front so we can focus it without awaiting the response.
        const asChild = opts?.asChild ?? false;
        const newId = newBlockId();
        // Enter over a selected range splits the line as the DELETION leaves
        // it: the op carries those runs, so the tail (seeded from them) starts
        // after the range. The origin's doc loses the range below, inside the
        // same entry — by the truncation when it cuts past the range anyway,
        // by an explicit delete when the origin keeps its text (Enter at start).
        const deleteTo =
          opts?.deleteTo !== undefined && opts.deleteTo > position
            ? opts.deleteTo
            : null;
        const runs =
          deleteTo !== null && opts?.runs
            ? joinAroundSpan(opts.runs, position, opts.runs, deleteTo)
            : opts?.runs;
        const op: BlockOp = {
          kind: "split",
          blockId,
          position,
          newId,
          asChild,
          childType: opts?.childType,
          siblingType: opts?.siblingType,
          tailData: opts?.tailData,
          runs,
        };

        // Enter at the START of a NON-EMPTY block: the reducer inserts an empty
        // sibling ABOVE and leaves the origin completely untouched (id, full
        // text, children, content doc, expanded, data). The caret is already at
        // offset 0 and never lost focus — the Enter keydown was preventDefaulted,
        // so DOM focus stays in the origin editor. So do NOT `focusNew` (that
        // would steal focus to the new empty block), do NOT truncate the origin's
        // live doc (nothing moved out of it — no runs edit), and
        // record a PLAIN structural entry. `derivePatchEntry` sees the empty block
        // as the sole insert, so with `focusId = blockId` (the ORIGIN) redo re-focuses
        // the origin and undo (which deletes the empty block) also lands on the origin —
        // never `<body>`. The empty block seeds a trivially-empty content doc on
        // mount, exactly like a gutter-`+` insert. `runsLength > 0` isolates this
        // from empty-block Enter (position 0 but nothing after the caret), which
        // must keep spawning a plain empty sibling BELOW with the caret moving down.
        if (!asChild && position === 0 && runsLength(runs ?? []) > 0) {
          const applied = applyOverlay(op);
          if (!applied) return;
          if (deleteTo === null) {
            recordStructural(
              applied.before,
              applied.after,
              OP_LABELS.split,
              blockId,
              applied.entryId,
            );
            return;
          }
          // A range from the line's start: the origin keeps its id and the
          // text AFTER the range, so the range is cut from its doc — one
          // entry with the split. Deferred for the truncation's reason below.
          queueMicrotask(() => {
            const cut = (): void => {
              authority.surgeryOf(blockId)?.deleteRange?.(0, deleteTo);
            };
            const owner = blockDocOwnerOf(blockId);
            const originBefore = owner?.runsNow();
            if (owner) owner.untracked(cut);
            else cut();
            const originAfter = owner?.runsNow();
            recordEntry({
              label: OP_LABELS.split,
              focusId: blockId,
              before: applied.before,
              after: applied.after,
              id: applied.entryId,
              runsEdits:
                originBefore === undefined ||
                originAfter === undefined ||
                runsEqual(originBefore, originAfter)
                  ? []
                  : [{ blockId, before: originBefore, after: originAfter }],
            });
          });
          return;
        }

        // --- existing path (mid/end split, empty-block Enter, asChild) ---
        // Dispatched BEFORE the caret claims the new block, so a split the zoom
        // refuses claims nothing and truncates nothing — the origin keeps its
        // text and its caret. Same synchronous turn either way, so the landing
        // still precedes the commit that mounts the new block.
        const applied = applyOverlay(op);
        if (!applied) return;
        const { before, after, entryId } = applied;
        focusNew(newId);
        // The reducer left the HEAD in this block's row, but the bound editor
        // ignores rows — the LIVE content must be truncated from the caret
        // too. The op's `runs` were captured from the live editor BEFORE this
        // truncation, so the new block's `data.text` seed (the tail its content
        // doc initializes from on mount) is caret-exact. Driving the deletion
        // through Lexical (`truncateAt`) lets the collab binding sync it into
        // the content doc like any local edit — and the entry recorded below
        // carries that doc edit as DATA beside the structural patch (the
        // origin's runs before the cut → the head), so a single Cmd+Z removes
        // the new block AND restores this block's full pre-split content (rows
        // and docs reverse together, never half).
        //
        // The truncation is DEFERRED a microtask: `split` is called from a
        // Lexical command handler, i.e. INSIDE this editor's own update — a
        // nested `editor.update` (even `discrete`) is queued by Lexical, so a
        // synchronous truncation call here would commit (and transact into
        // Yjs) only after the `untracked` scope closed, escaping it and
        // double-recording as a plain typing entry. One microtask puts it
        // outside the outer update; record order is unaffected (no other
        // record can interleave within the same task).
        //
        // `originBefore` is the DOC's runs (the authority) when the block has
        // a live owner — the op's `runs` are the editor's VIEW at keydown and
        // the row is a lagged projection, either of which can differ from what
        // the doc holds by the time the cut lands. No owner ⇒ no doc to edit
        // and nothing to replay: the entry stays structural.
        queueMicrotask(() => {
          const owner = blockDocOwnerOf(blockId);
          const truncate = (): void => {
            authority.surgeryOf(blockId)?.truncateAt?.(position);
          };
          if (!owner) {
            truncate();
            recordEntry({
              label: OP_LABELS.split,
              focusId: newId,
              before,
              after,
              id: entryId,
            });
            return;
          }
          const originBefore = owner.runsNow();
          const [head] = splitRuns(originBefore, position);
          owner.untracked(truncate);
          recordEntry({
            label: OP_LABELS.split,
            focusId: newId,
            before,
            after,
            id: entryId,
            runsEdits: runsEqual(originBefore, head)
              ? []
              : [{ blockId, before: originBefore, after: head }],
          });
        });
      },
      merge(opts?: { runs?: RichText }) {
        // Thin executor: `resolveKeystroke` already decided this is a merge (not
        // an outdent). Backspace-at-start merges THIS block up into the previous
        // visible line — the source is this block.
        mergeBlock(blockId, opts?.runs);
      },
      mergeNext() {
        // Delete-at-end merges the NEXT visible line UP into this block — the
        // source is that next line, not this one. By the completed visible-line
        // duality `prevVisibleLine(next) === this block`, so `mergeBlock` appends
        // into THIS (focused) editor and lands the caret at the join — i.e. the
        // caret does not move, which is what forward-delete must do.
        const nodes = toNodes(rowsRef.current);
        const block = nodes.find((b) => b.id === blockId);
        if (!block) return;
        const next = nextVisibleLine(nodes, block, isAnchorNode);
        if (!next) return; // defensive: nothing below to pull up
        // Read the next block's LIVE runs from its registered handle — the
        // authoritative source (its `data.text` projection lags by up to ~1s, so
        // falling back to it would silently drop text just typed there, an
        // absorbed failure). Fall back to `runsOfNode` ONLY when the block has no
        // handle: a text-less block (divider/image/file/embed) registers none,
        // and its empty runs are the TRUE answer, not a lagged miss.
        const nextHandle = authority.surgeryOf(next.id);
        const runs = nextHandle?.readRuns
          ? nextHandle.readRuns()
          : runsOfNode(next);
        mergeBlock(next.id, runs);
      },
      remove() {
        dispatchOp({ kind: "delete", blockIds: [blockId] });
      },
      indent() {
        // Thin executor: the "has a previous sibling to nest under" guard is owned
        // by `resolveKeystroke`; the reducer is a no-op if it somehow isn't. The
        // caret stays in this block, so re-focus it — unlike the selection-mode
        // bulk path, which keeps focus on the selection container.
        indentBlocks([blockId]);
        focusBlock(blockId);
      },
      outdent() {
        // Thin executor: the "is indented" guard is owned by `resolveKeystroke`;
        // the reducer is a no-op for a top-level block.
        outdentBlocks([blockId]);
        focusBlock(blockId);
      },
      navigate(dir, caret) {
        const flat = flatOrderRef.current;
        const idx = flat.findIndex((b) => b.id === blockId);
        if (idx < 0) return;
        // Skip void blocks with no registered focus handle (e.g. images), landing
        // on the nearest focusable block in this direction.
        const step = dir === "up" || dir === "left" ? -1 : 1;
        let j = idx + step;
        while (j >= 0 && j < flat.length && !authority.hasHandle(flat[j]!.id)) {
          j += step;
        }
        const target = flat[j];
        // Keyboard cross-block navigation is scroll-wanted: the caret is moving
        // to a block the user may not be looking at, so follow it into view.
        if (target) {
          authority.landIfMounted(target.id, (handle, land) =>
            landCaret(handle, dir, caret, { scroll: true, ...land }),
          );
          return;
        }
        // Running off the block order is not a dead end: the host may render a
        // caret surface right before/after the list (the page title). Blocks and
        // host chrome land the caret through the exact same rules — the only
        // difference is that host chrome is not a block, so it is not the
        // authority's to hold.
        const surface: CaretSurface | null | undefined = (
          step < 0 ? caretBeforeRef.current : caretAfterRef.current
        )?.current;
        if (!surface) {
          // The outer edge of the caret space: no block that way, and no host
          // chrome beyond the list either. A VERTICAL arrow still means
          // something here — with no line below, "down" means the end of the
          // text, which is what a textarea, an `<input>` and every editor do on
          // the last line — so the caret collapses to this block's own far edge
          // instead of the press being swallowed. Horizontal arrows are left
          // alone: `nav left`/`nav right` are only ever resolved AT the block's
          // start/end, so there is no next character to move to, and Backspace
          // at the very start must not masquerade as a caret move.
          if (dir === "up" || dir === "down") {
            authority.landIfMounted(blockId, (handle, land) =>
              landCaretAtOwnEdge(handle, dir, { scroll: true, ...land }),
            );
          }
          return;
        }
        // Leaving the block list entirely: no block owns the caret anymore, so
        // drop the focused-block state (an empty block would otherwise keep
        // showing its "Type '/' for commands" placeholder while the caret sits
        // in the title). A block target sets it back through its own `onFocus`.
        setFocusedBlockId(null);
        landCaret(surface, dir, caret, { scroll: true });
      },
      onFocus() {
        setFocusedBlockId(blockId);
      },
    }),
    [
      dispatchOp,
      indentBlocks,
      outdentBlocks,
      focusNew,
      focusBlock,
      commitRow,
      convertRow,
      applyOverlay,
      recordStructural,
      recordEntry,
      mergeBlock,
      isAnchorNode,
      authority,
      scope,
      firstUnder,
    ],
  );

  const value = useMemo<BlockEditorContextValue>(
    () => ({
      pageId,
      scope,
      admits,
      blocks: store.data,
      serverIds,
      rowTruthOf,
      loadingBelow: store.loadingBelow,
      failedBelow: store.failedBelow,
      enabledBlockTypes,
      allowAttachments: serverSync,
      serverSync,
      focusedBlockId,
      setFocusedBlockId,
      registerFocusHandle,
      attachContainer: authority.attachContainer,
      makeBlockAPI,
      convertStrippingText,
      stripText,
      setFlatOrder,
      setRows,
      rowsRef,
      focusBlock,
      focusBlockBoundary,
      move,
      indentBlocks,
      outdentBlocks,
      unwrapBlock,
      bulkDelete,
      bulkMove,
      bulkDuplicate,
      paste,
      splice,
      insertionPointAt,
      textReadsOf: authority.surgeryOf,
      deleteSpan,
      replaceSpan,
      insert,
      insertFirst,
      projectText,
      commitRecordedRowData,
      recordTextEdit,
      recordDocEdit,
      undo,
      redo,
      canUndo,
      canRedo,
      blockMenuDraftId,
      requestBlockMenu,
      clearBlockMenu,
    }),
    [
      pageId,
      scope,
      admits,
      store.data,
      serverIds,
      rowTruthOf,
      store.loadingBelow,
      store.failedBelow,
      enabledBlockTypes,
      serverSync,
      focusedBlockId,
      setFocusedBlockId,
      registerFocusHandle,
      authority,
      makeBlockAPI,
      convertStrippingText,
      stripText,
      setFlatOrder,
      setRows,
      focusBlock,
      focusBlockBoundary,
      move,
      indentBlocks,
      outdentBlocks,
      unwrapBlock,
      bulkDelete,
      bulkMove,
      bulkDuplicate,
      paste,
      splice,
      insertionPointAt,
      deleteSpan,
      replaceSpan,
      insert,
      insertFirst,
      projectText,
      commitRecordedRowData,
      recordTextEdit,
      recordDocEdit,
      undo,
      redo,
      canUndo,
      canRedo,
      blockMenuDraftId,
      requestBlockMenu,
      clearBlockMenu,
    ],
  );

  return (
    <BlockEditorContext.Provider value={value}>
      {children}
    </BlockEditorContext.Provider>
  );
}
