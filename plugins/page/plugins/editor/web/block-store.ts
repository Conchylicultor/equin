// The persistence seam for the block editor. `BlockEditorProvider` consumes a
// `BlockStore` for ALL reads/writes and is otherwise storage-agnostic: recording/
// undo, focus management, and `makeBlockAPI` never touch a store's internals.
//
// Two implementations share one shape:
//   - `useServerBlockStore`  — the persistent path: the
//     `useOptimisticResource(pageBlocks, { where: { pageId } }, …)` overlay,
//     and nothing else.
//   - `useMemoryBlockStore`  — an authoritative in-memory `useState<Block[]>`,
//     the source of truth itself (no overlay, no confirmation, no network). Its
//     writes reuse the SAME pure helpers as the server (`applyOverlayOp`, the
//     reducer), so op/patch semantics are byte-identical.

import { useCallback, useMemo, useRef, useState } from "react";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  OpNoLongerApplies,
  useOptimisticResource,
} from "@plugins/primitives/plugins/optimistic-mutation/web";
import {
  applyBlockOpEndpoint,
  patchBlocks,
  pageBlocks,
  type Block,
} from "../core";
import {
  applyOverlayOp,
  isPatchReflected,
  isReflected,
  sameOverlayTarget,
  type BlockOverlayOp,
} from "./internal/optimistic-block-ops";
import { useBlockOpContext } from "./internal/block-handles";

/**
 * A store is `pending` until its first authoritative rows land, and only then
 * {@link SettledBlockStore} — the one arm with rows and a `dispatch`. A pending
 * store whose first load FAILED carries that `error` (null while it is simply
 * loading), so the gate renders the failure instead of loading forever. There is
 * no placeholder document: an op can never be folded onto rows nobody has
 * seen, and the provider (whose hooks read the rows unconditionally) takes the
 * settled arm only, so it cannot be mounted on a pending store (a tsc error).
 * `BlockEditorProviderGate` is the one place that tells the two apart.
 */
export type BlockStore = PendingBlockStore | SettledBlockStore;

/**
 * The not-yet-settled arm: `useOptimisticResource`'s `loading` / `error` arms
 * folded into the store's own `pending` vocabulary — still loading, or a failed
 * first load carrying the read's `refetch` for its Retry.
 */
export type PendingBlockStore =
  | { pending: true; error: null }
  | {
      pending: true;
      /** The first load's failure. */
      error: Error;
      /** Re-fetch the failed load — the gate's Retry. */
      refetch: () => Promise<void>;
    };

/**
 * The full read/write surface the provider needs. Recording for undo stays in
 * the provider — a store only applies/persists.
 *
 * `dispatch` is the ONLY write member, and that is the invariant, not a
 * coincidence: every structural mutation the editor can make is a `BlockOp` (or
 * the undo/redo `BlockPatch`), so every one of them flows through the same
 * overlay, the same reducer and the same ordered send lane. `paste`,
 * `bulkDuplicate`, `move`, `bulkDelete` and `bulkMove` each used to have a member
 * here, and that is precisely how they reached the network without passing the
 * provider's `dispatchOp` — the one place that records an undo entry — and
 * without joining the page's write order. A new member here would be a claim
 * that some mutation is not expressible as an op; there are none left.
 */
export interface SettledBlockStore {
  pending: false;
  /** Current document rows (server truth + overlay, or the in-memory truth). */
  data: Block[];
  /**
   * AUTHORITATIVE rows with NO optimistic overlay — the raw resource base on the
   * server path, the in-memory truth on the memory path. The provider derives
   * `serverIds` from it (the doc-init FK gate, Stage 4a): a freshly created /
   * split block is in `data` (overlay) before its row lands here. In memory
   * every row is authoritative from the start, so `serverData === data`.
   */
  serverData: Block[];
  /**
   * Rows below which content is still LOADING: the anchor (sub-page or
   * page-link row) of an expanded nested page whose own feed has not landed yet
   * (the composite store, `composite-block-store.tsx`). Such a page contributes
   * no rows — not an empty list of them — and the editor renders a loading
   * region under its anchor instead. Empty for a single page and in memory.
   */
  loadingBelow: ReadonlySet<string>;
  /**
   * Rows below which content FAILED to load: the anchor of an expanded nested
   * page whose own feed's first load failed, with that failure and its Retry.
   * Such a page contributes no rows, as while loading, but the editor renders
   * the failure under its anchor — never a loading region that never ends. A
   * row is in at most one of `loadingBelow` / `failedBelow`. Empty for a single
   * page and in memory.
   */
  failedBelow: ReadonlyMap<string, BelowFailure>;
  /**
   * Apply a structural op / undo-redo patch through the overlay pipeline.
   * `onRejected` runs if the server PERMANENTLY rejects the write (the
   * prediction has then already left the overlay, and the user has been told)
   * — the provider's cue to drop the undo entry that recorded it. It may run
   * more than once for one dispatch (a write routed to several pages); the
   * in-memory store never calls it.
   */
  dispatch: (v: BlockOverlayOp, onRejected?: () => void) => void;
}

/** The still-loading arm, shared: it carries nothing, so one object serves every store. */
export const PENDING_BLOCK_STORE: PendingBlockStore = {
  pending: true,
  error: null,
};

/** No row has anything loading below it (a single page; memory). */
export const NOTHING_LOADING: ReadonlySet<string> = new Set();

/** A nested page's failed first load, as its anchor row renders it. */
export interface BelowFailure {
  error: Error;
  /** Re-fetch the failed load — the anchor's Retry. */
  refetch: () => Promise<void>;
}

/** No row has a failed load below it (a single page; memory). */
export const NOTHING_FAILED: ReadonlyMap<string, BelowFailure> = new Map();

// ---------------------------------------------------------------------------
// Server-backed store (the persistent path).
// ---------------------------------------------------------------------------

export function useServerBlockStore(pageId: string): BlockStore {
  // Structural keystroke ops apply optimistically: the client runs the SAME
  // `applyBlockOp` reducer the server runs, overlaid on live-state truth and
  // reconciled by the WS push. The captured `effect` drives both the idempotency
  // apply-guard (in `applyOverlayOp`) and content-based confirmation here.
  // The base is the page's scope of `pageBlocks`: its rows in order, a scoped
  // delta merged into them by id — confirmed by the exact ack of an op's
  // commit or by content, denied only by a full frame's watermark (Rule B′).
  const scope = useMemo(() => ({ where: { pageId } }), [pageId]);
  // The reducer's type facts, minted from the block-handle registry. The SERVER
  // mints the same context from its own registry through the same
  // `blockOpContextOf` and passes it to the same `applyBlockOp`; if the two ever
  // disagreed, an op would predict one forest here and commit another there, and
  // could never confirm.
  const opCtx = useBlockOpContext();
  const apply = useCallback(
    (blocks: Block[], v: BlockOverlayOp) => applyOverlayOp(blocks, v, opCtx),
    [opCtx],
  );
  // Per-dispatch rejection callbacks, keyed by the dispatched op OBJECT — the
  // very `vars` the primitive hands back to `onError`. Weak, so an op that
  // confirms (or is never rejected) leaves nothing behind.
  const rejectHandlersRef = useRef(new WeakMap<BlockOverlayOp, () => void>());
  const optimistic = useOptimisticResource(pageBlocks, scope, {
    apply,
    // Names the surface in the sync cloud and the rejection toast.
    label: "Page",
    onError: (_err, v, { rejected }) => {
      if (!rejected) return;
      const onRejected = rejectHandlersRef.current.get(v);
      if (onRejected) onRejected();
    },
    // Structural ops keep their own `op` endpoint; undo/redo patches POST to the
    // generic `patch` endpoint. Both flow through this one instance so the
    // overlay + freeze pipeline (and confirmation) is shared — and so both ride
    // the primitive's per-`(resource, params)` send lane, which is what keeps
    // causally dependent writes in issue order on the wire.
    mutate: (v) =>
      v.tag === "patch"
        ? fetchEndpoint(patchBlocks, { pageId }, { body: v.patch }).then(
            (r) => ({
              watermark: r.watermark,
            }),
          )
        : fetchEndpoint(applyBlockOpEndpoint, { pageId }, { body: v.op }).then(
            (r) => ({
              watermark: r.watermark,
            }),
          ),
    isConfirmedBy: (serverData, v) =>
      v.tag === "patch"
        ? isPatchReflected(serverData, v.patch, v.restoreIds)
        : isReflected(serverData, v.effect),
    // Op identity for cascade confirmation: only a newer confirmed op writing
    // the SAME block row(s) may supersede an older resolved one, so an inverse
    // undo/redo pair (shared id set) cascades while an unrelated block's
    // confirmation can never drop another block's still-pending write (e.g. a
    // `projectText` projection patch). See the editor CLAUDE.md.
    sameTarget: sameOverlayTarget,
    // Bounded op summary for the divergence report (raw `vars` is never shipped).
    describeOp: (v) => (v.tag === "patch" ? "patch" : v.op.kind),
  });

  // Reference-stable per settled render (the hook memoizes its result), so the
  // composite's per-feed snapshot only moves when the rows do.
  return useMemo<BlockStore>(() => {
    switch (optimistic.status) {
      case "loading":
        return PENDING_BLOCK_STORE;
      case "error":
        return {
          pending: true,
          error: optimistic.error,
          refetch: optimistic.refetch,
        };
      case "ready":
        break;
    }
    const { data, serverData, dispatch } = optimistic;
    return {
      pending: false,
      data,
      serverData,
      loadingBelow: NOTHING_LOADING,
      failedBelow: NOTHING_FAILED,
      // The hook's dispatch returns the minted op id; the seam's is fire-and-forget.
      dispatch: (v, onRejected) => {
        if (onRejected) rejectHandlersRef.current.set(v, onRejected);
        dispatch(v);
      },
    };
  }, [optimistic]);
}

// ---------------------------------------------------------------------------
// In-memory store (authoritative, synchronous, no network).
// ---------------------------------------------------------------------------

// Takes no `pageId`: the memory document is one synthetic page whose rows already
// carry it, and the only write that ever needed the page's own id was `paste`
// (now the provider's, which knows it).
export function useMemoryBlockStore({
  initialBlocks,
}: {
  initialBlocks: Block[];
}): SettledBlockStore {
  const [rows, setRowsState] = useState<Block[]>(initialBlocks);
  // The authoritative rows are also mirrored into a ref updated synchronously by
  // every write, so writes chained within one event compose against the latest
  // truth rather than a stale render snapshot.
  const rowsRef = useRef<Block[]>(initialBlocks);
  // Same reducer facts as the server path — an in-memory document must apply an
  // op exactly as a persisted one does (see `useServerBlockStore`).
  const opCtx = useBlockOpContext();
  const commit = useCallback((next: Block[]) => {
    rowsRef.current = next;
    setRowsState(next);
  }, []);

  const dispatch = useCallback(
    (v: BlockOverlayOp) => {
      // Byte-identical op/patch semantics to the server (same reducer). The overlay
      // apply-guard throws `OpNoLongerApplies` when the base already reflects the
      // op/patch — in memory that means a no-op replay, so keep the current rows.
      try {
        commit(applyOverlayOp(rowsRef.current, v, opCtx));
      } catch (err) {
        if (err instanceof OpNoLongerApplies) return;
        throw err;
      }
    },
    [commit, opCtx],
  );

  return useMemo<SettledBlockStore>(
    () => ({
      pending: false,
      data: rows,
      // Every in-memory row is authoritative from the start (no overlay), so the
      // doc-init FK gate is a no-op — `serverIds` covers all blocks.
      serverData: rows,
      loadingBelow: NOTHING_LOADING,
      failedBelow: NOTHING_FAILED,
      dispatch,
    }),
    [rows, dispatch],
  );
}
