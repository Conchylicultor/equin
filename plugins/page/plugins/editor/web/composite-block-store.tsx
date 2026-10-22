// The composite block store: inline nested-page expansion as a THIRD
// `BlockStore` implementation. `CompositeServerProviderHost` mounts one
// `useServerBlockStore` feed per expanded page reachable from the base
// (`deriveMounts`), composes their rows into one union document, and routes
// every write back to the page that owns its rows — so `BlockEditorProviderInner`
// (and the whole render/reducer/undo/CRDT stack) sees a single flat document
// with the page boundary as data, not component structure. See
// `research/2026-07-23-page-inline-nested-page-expansion.md`.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { enqueueDetachedWrite } from "@plugins/primitives/plugins/optimistic-mutation/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  moveBlock,
  moveBlocks,
  pageBlocks,
  patchBlocks,
  type Block,
} from "../core";
import {
  BlockEditorProviderGate,
  type ProviderHostViewProps,
} from "./block-editor-context";
import {
  NOTHING_FAILED,
  NOTHING_LOADING,
  PENDING_BLOCK_STORE,
  useServerBlockStore,
  type BelowFailure,
  type BlockStore,
  type PendingBlockStore,
  type SettledBlockStore,
} from "./block-store";
import type { BlockOverlayOp } from "./internal/optimistic-block-ops";
import {
  deriveMounts,
  groupPatchByOwnerPage,
  insertOwnerPage,
  pageByAnchor,
  remapUnionParents,
  rowOwnerPage,
  singleOwnerPage,
  splitOpByOwnerPage,
  translateOpForStore,
  translatePatchForStore,
  translateUnionParentId,
} from "./internal/composition";

/**
 * One mounted feed's published state: `pending` until the page's first
 * authoritative rows land — a pending feed has NO rows, not an empty list of
 * them, and carries its first load's failure as `error` (null while loading) —
 * then `data`/`serverData`, the render-driving snapshot
 * (reference-stable through `useOptimisticResource`'s memoization), and a
 * stable-identity `dispatch` that routes to the feed's CURRENT store, so
 * routed writes always reach the latest render's callbacks without the
 * registry churning on every store re-creation.
 */
type FeedSnapshot =
  | PendingBlockStore
  | {
      pending: false;
      data: Block[];
      serverData: Block[];
      dispatch: SettledBlockStore["dispatch"];
    };

/** Reference-identical state — what the publish convergence guard compares. */
function sameSnapshot(a: FeedSnapshot, b: FeedSnapshot): boolean {
  if (a.pending || b.pending) {
    return a.pending && b.pending && a.error === b.error;
  }
  return (
    a.data === b.data &&
    a.serverData === b.serverData &&
    a.dispatch === b.dispatch
  );
}

/**
 * The sanctioned dynamic-hook-count seam: the composite renders one
 * `PageFeedMount` per mounted page, and each mount calls exactly one
 * `useServerBlockStore`. The snapshot publishes via an effect keyed on the
 * reference-stable store; the host's `setFeeds` bails on reference-equal
 * snapshots, so a no-op push can never loop publish→render→publish.
 */
function PageFeedMount({
  pageId,
  onSnapshot,
  onRelease,
}: {
  pageId: string;
  onSnapshot: (pageId: string, snapshot: FeedSnapshot) => void;
  onRelease: (pageId: string) => void;
}) {
  const store = useServerBlockStore(pageId);
  const storeRef = useLatestRef(store);
  // Stable per mount. The mount is keyed by its page, so its read never changes
  // tuple, and a read that has landed a value never goes back to pending — the
  // throw is that invariant stated, not a state this can reach.
  const dispatch = useCallback(
    (v: BlockOverlayOp, onRejected?: () => void) => {
      const current = storeRef.current;
      if (current.pending) {
        throw new Error(`Page ${pageId}'s feed went back to loading`);
      }
      current.dispatch(v, onRejected);
    },
    [pageId, storeRef],
  );
  useEffect(() => {
    onSnapshot(
      pageId,
      store.pending
        ? store
        : {
            pending: false,
            data: store.data,
            serverData: store.serverData,
            dispatch,
          },
    );
  }, [pageId, store, dispatch, onSnapshot]);
  useEffect(() => () => onRelease(pageId), [pageId, onRelease]);
  return null;
}

/**
 * The server-backed provider host: the composite union over every mounted
 * page's feed, handed to the storage-agnostic provider as one `BlockStore` —
 * through `BlockEditorProviderGate`, which mounts the provider only once the
 * base page's rows have landed. With no expanded nested page it degenerates to
 * exactly one feed (the base page) and identity composition.
 */
export function CompositeServerProviderHost({
  pageId: basePageId,
  enabledBlockTypes,
  caretBefore,
  caretAfter,
  rootId,
  children,
}: {
  pageId: string;
  enabledBlockTypes?: readonly string[];
  children: ReactNode;
} & ProviderHostViewProps) {
  // The detached writes (cross-page moves, patches to an unsettled page) go to
  // the host this editor is served by, like every feed's own writes.
  const fetchEndpoint = useFetchEndpoint();
  const [feeds, setFeeds] = useState<ReadonlyMap<string, FeedSnapshot>>(
    () => new Map<string, FeedSnapshot>(),
  );

  const publishFeed = useCallback((pageId: string, snapshot: FeedSnapshot) => {
    setFeeds((prev) => {
      const cur = prev.get(pageId);
      // Convergence guard: a publish carrying reference-identical state must
      // return the SAME map, or each push would mint a new union and re-run the
      // publish effect forever.
      if (cur && sameSnapshot(cur, snapshot)) return prev;
      const next = new Map(prev);
      next.set(pageId, snapshot);
      return next;
    });
  }, []);

  const releaseFeed = useCallback((pageId: string) => {
    setFeeds((prev) => {
      if (!prev.has(pageId)) return prev;
      const next = new Map(prev);
      next.delete(pageId);
      return next;
    });
  }, []);

  // A pending feed is absent from `rowsByPage`, exactly like one that has not
  // published yet: it contributes no further expansions until its rows land.
  const mounts = useMemo(() => {
    const rowsByPage = new Map<string, readonly Block[]>();
    for (const [pageId, feed] of feeds) {
      if (!feed.pending) rowsByPage.set(pageId, feed.data);
    }
    return deriveMounts(basePageId, rowsByPage);
  }, [basePageId, feeds]);

  // The union document, concatenated in mount (BFS) order and remapped into
  // union space (page-link content nests under its link row). Render order is
  // irrelevant here — the editor sorts by rank + buildTree — but a stable
  // concatenation keeps the array reference-cheap to diff.
  const data = useMemo(() => {
    const union: Block[] = [];
    for (const pageId of mounts.keys()) {
      const feed = feeds.get(pageId);
      if (feed && !feed.pending) union.push(...feed.data);
    }
    return remapUnionParents(union, mounts);
  }, [feeds, mounts]);

  // Authoritative rows, un-remapped: consumers read only row ids off it (the
  // doc-init FK gate's `serverIds`, the projection's existence gate).
  const serverData = useMemo(() => {
    const union: Block[] = [];
    for (const pageId of mounts.keys()) {
      const feed = feeds.get(pageId);
      if (feed && !feed.pending) union.push(...feed.serverData);
    }
    return union;
  }, [feeds, mounts]);

  // A still-loading expanded child must not blank the whole editor, and must not
  // read as an empty page either: it contributes no rows, and its ANCHOR (the
  // sub-page or page-link row it expands under) is named here, so the editor
  // renders a loading region in its place. A feed that has not published yet is
  // loading too — the mount exists, its answer does not.
  const loadingBelow = useMemo(() => {
    const anchors = new Set<string>();
    for (const [pageId, anchorId] of mounts) {
      if (pageId === basePageId) continue;
      const feed = feeds.get(pageId);
      if (!feed || (feed.pending && feed.error === null)) anchors.add(anchorId);
    }
    // The shared empty set when nothing loads, so a push that changes no
    // expansion hands the context no new identity for it.
    return anchors.size === 0 ? NOTHING_LOADING : anchors;
  }, [basePageId, feeds, mounts]);

  // A child feed whose first load FAILED is not loading: its anchor renders the
  // failure with Retry instead of a loading region that never ends.
  const failedBelow = useMemo(() => {
    const failed = new Map<string, BelowFailure>();
    for (const [pageId, anchorId] of mounts) {
      if (pageId === basePageId) continue;
      const feed = feeds.get(pageId);
      if (feed?.pending && feed.error !== null) {
        failed.set(anchorId, { error: feed.error, refetch: feed.refetch });
      }
    }
    return failed.size === 0 ? NOTHING_FAILED : failed;
  }, [basePageId, feeds, mounts]);

  // The BASE feed alone decides whether the editor has a document at all — and
  // its failed first load is the editor's failure. (A failed CHILD feed
  // renders under its anchor — `failedBelow`.)
  const baseFeed = feeds.get(basePageId) ?? PENDING_BLOCK_STORE;
  const basePending: PendingBlockStore | null = baseFeed.pending
    ? baseFeed
    : null;

  // Cumulative indexes for writes that outlive their feed (undo entries are
  // mount-scoped to the EDITOR, not to a child feed, so they can replay after
  // the child collapsed):
  //  - row id → owning page, for update/delete ids whose row left the union;
  //  - every translated (page-link) anchor ever mounted, mapped to its page, so
  //    recorded union-space parents still translate after the link collapsed.
  // Append-only and bounded by the rows seen during this editor's mount —
  // exactly the ids a mount-scoped undo thunk can still name.
  const seenOwnersRef = useRef(new Map<string, string>());
  const seenAnchorsRef = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [pageId, feed] of feeds) {
      if (feed.pending) continue;
      for (const row of feed.data) seenOwnersRef.current.set(row.id, pageId);
    }
    for (const [anchorId, pageId] of pageByAnchor(mounts)) {
      seenAnchorsRef.current.set(anchorId, pageId);
    }
  }, [feeds, mounts]);

  const feedsRef = useLatestRef(feeds);
  const mountsRef = useLatestRef(mounts);
  const dataRef = useLatestRef(data);

  // The owning page's live dispatch. Throws on an unmounted page, and on one
  // whose rows are still loading: an OP targets rows the user can currently
  // see, and a loading page shows none, so a miss is a routing bug — fail
  // loudly. (The two writes that legitimately have no settled feed — the
  // detached patch persist and the cross-page move — never come through here.)
  const dispatchFor = useCallback(
    (owner: string): ((v: BlockOverlayOp, onRejected?: () => void) => void) => {
      const feed = feedsRef.current.get(owner);
      if (!feed) throw new Error(`No mounted feed for page ${owner}`);
      if (feed.pending) {
        throw new Error(`Page ${owner}'s rows are still loading`);
      }
      return feed.dispatch;
    },
    [],
  );

  /**
   * A drop whose source and destination live on DIFFERENT pages permutes two
   * forests at once, and no per-page overlay can predict it: the moved row leaves
   * the source page's `pageBlocks` entirely (the server re-stamps its
   * `page_id`), so the source feed could never confirm a `reparent` effect that
   * names a row it will never hold again.
   *
   * So a cross-page move stays on the id-scoped `moveBlock` endpoint, which is
   * already cross-page-aware (it locks BOTH forests, recomputes `page_id`, and
   * notifies both scopes). What Stage 4 gives it is ORDER: the write is enqueued
   * on the SOURCE page's send lane, so it still departs after every structural
   * write the user issued before it. There is nothing to predict; there is
   * something to order.
   */
  const moveAcrossPages = useCallback(
    (
      sourcePageId: string,
      op: Extract<
        Extract<BlockOverlayOp, { tag: "op" }>["op"],
        { kind: "move" | "bulkMove" }
      >,
      onRejected: (() => void) | undefined,
    ) => {
      const parentId = translateUnionParentId(op.parentId, mountsRef.current);
      // Nothing was predicted, so a rejection has nothing to roll back — but
      // the move is lost, so it is reported (toast + report) like any other.
      const info = { label: "Page", describe: op.kind, onRejected };
      if (op.kind === "move") {
        enqueueDetachedWrite(
          pageBlocks,
          { where: { pageId: sourcePageId } },
          info,
          () =>
            fetchEndpoint(
              moveBlock,
              { id: op.blockId },
              { body: { parentId, targetId: op.targetId, zone: op.zone } },
            ),
        );
        return;
      }
      // A dragged SELECTION crossing pages: the same reasoning, one write for
      // the whole set so it lands atomically.
      enqueueDetachedWrite(
        pageBlocks,
        { where: { pageId: sourcePageId } },
        info,
        () =>
          fetchEndpoint(
            moveBlocks,
            {},
            { body: { ids: op.ids, parentId, afterId: op.afterId } },
          ),
      );
    },
    [fetchEndpoint],
  );

  const dispatch = useCallback(
    (v: BlockOverlayOp, onRejected?: () => void) => {
      const curMounts = mountsRef.current;
      if (v.tag === "patch") {
        // A patch may legitimately span pages (undoing a cross-page bulk
        // delete), so split it per owner. Update + delete ids carry no page of
        // their own, so they resolve through the union first, then the
        // cumulative index (rows that left with a collapse).
        const rows = dataRef.current;
        const ownerOf = (id: string) =>
          rows.find((b) => b.id === id)?.pageId ??
          seenOwnersRef.current.get(id) ??
          null;
        for (const [owner, group] of groupPatchByOwnerPage(v.patch, ownerOf)) {
          const patch = translatePatchForStore(group, seenAnchorsRef.current);
          const feed = feedsRef.current.get(owner);
          if (feed && !feed.pending) {
            // The whole gesture's `restoreIds` ride along: the set is keyed by
            // row id, which neither grouping nor translation rewrites, and a
            // predicate only consults it for the creates its own group carries.
            feed.dispatch(
              {
                tag: "patch",
                patch,
                restoreIds: v.restoreIds,
              },
              onRejected,
            );
          } else {
            // Detached persist (undo/redo targeting a collapsed page, or one
            // re-expanded whose rows have not landed yet): no settled feed means
            // no overlay base to predict on, so write the patch straight to the
            // owning page — the data stays correct, visible once its rows land.
            // The send lane is MODULE-level, so the write still joins that
            // page's own ordered stream, a loading feed's included: ordering
            // holds, there is simply nothing to predict.
            enqueueDetachedWrite(
              pageBlocks,
              { where: { pageId: owner } },
              { label: "Page", describe: "patch", onRejected },
              () =>
                fetchEndpoint(patchBlocks, { pageId: owner }, { body: patch }),
            );
          }
        }
        return;
      }
      // A cross-page drop — one block or a whole selection — is the ONE
      // structural write no page's overlay can carry — see `moveAcrossPages`.
      if (v.op.kind === "move" || v.op.kind === "bulkMove") {
        const rows = dataRef.current;
        const sourcePageId =
          v.op.kind === "move"
            ? rowOwnerPage(rows, v.op.blockId)
            : singleOwnerPage(rows, v.op.ids);
        const destPageId = insertOwnerPage(
          rows,
          v.op.parentId,
          curMounts,
          basePageId,
        );
        if (sourcePageId !== destPageId) {
          moveAcrossPages(sourcePageId, v.op, onRejected);
          return;
        }
      }
      // Every other op routes to the page owning its rows; only a `delete` set
      // may span pages, and it fans out into one op per page.
      for (const { owner, v: routed } of splitOpByOwnerPage(
        dataRef.current,
        v,
        curMounts,
        basePageId,
      )) {
        dispatchFor(owner)(
          translateOpForStore(routed, curMounts, seenAnchorsRef.current),
          onRejected,
        );
      }
    },
    [basePageId, dispatchFor, moveAcrossPages, fetchEndpoint],
  );

  // There are no routed write members left. Every structural mutation is a
  // `BlockOp` (or an undo/redo `BlockPatch`), so it arrives through `dispatch`,
  // where `resolveOpOwnerPage` applies the anchor rules the bespoke members used
  // to (row owner for a named block, `insertOwnerPage` when anchorless,
  // `singleOwnerPage` for the sets that must not span pages) and
  // `translateOpForStore` rewrites a page-link anchor `parentId` into the real
  // page id.
  const store = useMemo<BlockStore>(
    () =>
      basePending ?? {
        pending: false,
        data,
        serverData,
        loadingBelow,
        failedBelow,
        dispatch,
      },
    [basePending, data, serverData, loadingBelow, failedBelow, dispatch],
  );

  return (
    <>
      {[...mounts.keys()].map((pageId) => (
        <PageFeedMount
          key={pageId}
          pageId={pageId}
          onSnapshot={publishFeed}
          onRelease={releaseFeed}
        />
      ))}
      {/* The feed mounts above stay mounted either way — they ARE the reads.
          Only the provider waits for the base page's rows. */}
      <BlockEditorProviderGate
        store={store}
        pageId={basePageId}
        serverSync
        enabledBlockTypes={enabledBlockTypes}
        caretBefore={caretBefore}
        caretAfter={caretAfter}
        rootId={rootId}
      >
        {children}
      </BlockEditorProviderGate>
    </>
  );
}
