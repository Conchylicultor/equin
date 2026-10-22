import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Doc } from "yjs";
import type { Provider } from "@lexical/yjs";
import {
  useLiveRow,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import { yDocContent } from "@plugins/primitives/plugins/collab-doc/core";
import { blockDocs } from "@plugins/page/plugins/editor-collab/core";
import { coalesce, runsOf, xmlTextContentLength } from "../../core";
import type { ProjectTextFn } from "./doc-sourced-runs";
import type { RowTruth } from "./row-truth";
import { buildSeedStateFor } from "./block-seed-state";
import { useBlockDocs } from "./use-block-docs";
import {
  IDLE_SAVE_STATE,
  type CollabSaveState,
} from "./live-state-yjs-provider";
import type { BindingReplica } from "./binding-replica";
import type { BlockRunsEdit } from "./block-run-tracker";
import {
  ATTACHING_STATE,
  CollabSession,
  type SessionState,
} from "./collab-session";

/**
 * The `useCollabBlockDoc` hook — THE single seam between the editor and the
 * content-doc transport (per-block CRDT plan, Stage 2). Everything transport-
 * and run-recording-shaped lives behind this hook: a future delta-WS provider
 * swaps in here and nothing else in the editor changes. That includes "is this
 * block's prose saved yet" — the hook surfaces the provider's derived
 * {@link CollabSaveState} rather than handing the provider itself out, so the
 * consumer reports to the sync-status cloud without ever touching the
 * transport.
 *
 * ## Who owns what
 *
 * Ownership and lifetime live next door in `collab-session.ts` — read its
 * module comment first; this file is the React surface over it.
 *
 * - a **`BlockDocOwner`** per block id (module registry): the canonical
 *   `Y.Doc`, the transport provider, the run tracker. Two docs for one block
 *   would fork the CRDT, and three consumers need the union across every
 *   mounted binding.
 * - a **`CollabSession`** per (block, binding) — one per hook instance. It
 *   holds the owner BY REFERENCE (never by id), mints the per-binding
 *   {@link BindingReplica} `providerFactory` hands `CollaborationPlugin`, and
 *   owns the ONE deferred retention that covers StrictMode remounts, a binding
 *   that has not let go of its replica yet, and the provider's buffered-bytes
 *   teardown retention.
 *
 * What stays HERE is everything that needs React or the block's row: the
 * `data.text` seed builder, the render-accurate `RowTruth` value, the
 * subscription/FK-gate effects, the save-state store, and the
 * `content doc → data.text` projection (whose final flush must run inside this
 * hook's teardown, before the session ends).
 *
 * ## Per-binding replicas
 *
 * The Lexical binding does NOT attach to the shared canonical doc: each
 * session owns one {@link BindingReplica} — a fresh per-binding `Y.Doc` kept in
 * sync with the canonical by a bidirectional synchronous relay — and
 * `providerFactory` hands `CollaborationPlugin` THAT doc + provider. The
 * invariant (see `binding-replica.ts`): a binding always attaches to an empty
 * doc and receives ALL content as post-attach update events, so a second
 * simultaneous editor of the same block (inline nested-page expansion + the
 * page's detail pane) hydrates instead of rendering empty forever. Everything
 * else stays canonical-side, where all edits land synchronously via the relay:
 * the transport provider (and its save state), the run tracker, and the doc
 * observers below. Since CollaborationPlugin connects the replica, the replica
 * delegates connect/disconnect to the transport, refcounted per owner
 * (`replicaConnection`) — the transport HOLDS a delivered server state until
 * its connect(), so an unconnected transport would leave every block empty.
 *
 * ## Undo: the data channel
 *
 * `onRunsEdit` is the one text-history channel: the owner's run tracker
 * (`block-run-tracker.ts`) folds local transactions into idle-closed runs and
 * emits each as `{before, after}` runs, which the consumer records as a data
 * entry replayed through `applyBlockRuns` (`block-text-write-stored.ts`) —
 * onto the open doc when an editor holds one, onto the stored doc through the
 * server otherwise. No entry points into this hook's lifetime, which is what
 * lets a text entry outlive the editor that recorded it.
 *
 * `CollaborationPlugin`'s own forced per-block undo manager (over the replica)
 * stays inert: its UNDO/REDO commands are swallowed (collab-text-plugin) and a
 * replay's transactions don't match its tracked origins.
 */

/**
 * Debounce for the `content doc → data.text` projection write. Heavy on
 * purpose: rows only need to trail the doc closely enough for search /
 * backlinks / history — sub-second staleness is fine, and a long window keeps
 * `blocksChanged` fan-out bounded during a typing run.
 */
const PROJECT_DEBOUNCE_MS = 1000;

export type CollabProviderFactory = (
  id: string,
  yjsDocMap: Map<string, Doc>,
) => Provider;

/** What {@link useCollabBlockDoc} hands its consumer. */
export interface CollabBlockDoc {
  /** For `CollaborationPlugin`'s `providerFactory` prop. */
  providerFactory: CollabProviderFactory;
  /**
   * Bump this on the mounted `CollaborationPlugin`'s `key`. It changes only
   * when {@link rehydrate} runs, and a changed key is what actually re-attaches
   * the binding (Lexical builds its binding once per mount, behind a ref).
   */
  attachGeneration: number;
  /**
   * Live plain-text length of the CANONICAL doc — what this block's content
   * REALLY is, independent of what any binding managed to render. Half of the
   * hydration guard's comparison; the other half is the consumer's own
   * serialization of the editor.
   */
  docContentLength: () => number;
  /** Whether any local edit ever entered this doc (starvation discriminator). */
  hasLocalEdits: () => boolean;
  /**
   * Subscribe to every CANONICAL-doc update — local edits and applied server
   * states alike, one call per integrating transaction. The push-based trigger
   * for anything that must react to "this block's content moved" (today: the
   * consumer's blind-binding check). The projection has its own arming inside
   * the seam; this is the outward-facing seam of the same signal.
   */
  subscribeDocUpdates: (cb: () => void) => () => void;
  /**
   * Recover a block whose BINDING fell behind its doc: END this block's content
   * session and start a new one. A new session is a fresh EMPTY replica, which
   * is the only thing that fixes a binding that missed its post-attach
   * `observeDeep` set — and is also why it is DESTRUCTIVE: the text genuinely
   * leaves the DOM until the re-read lands. Use it for the defect it repairs
   * (`blind-binding`, and the user-pressed `stalled` Retry) and
   * {@link refetch} for everything else.
   */
  rehydrate: () => void;
  /**
   * Re-read the server's authoritative state into the canonical doc, WITHOUT
   * touching the replica or the session — nothing on screen changes, and a
   * false positive costs one idempotent doc-init instead of blanking the line.
   * The right verb for "the doc is behind the server" (`starved-doc`): the
   * binding is fine, so re-attaching it repairs nothing and destroys the text
   * on the way.
   */
  refetch: () => void;
  /**
   * Has the transport's authoritative answer landed for this block? `false`
   * means NO answer has arrived yet — so an empty doc proves nothing, and any
   * "the server never sent it" verdict read against it would be a guess about a
   * request still in flight.
   */
  isSynced: () => boolean;
  /**
   * Subscribe to the transport's `sync` announcement (the false→true edge, and
   * its re-announcement on reconnect). The push-based clock for anything that
   * must start counting from "the answer is in" rather than from mount.
   */
  subscribeSync: (cb: () => void) => () => void;
  /**
   * Has this block's text ever been on screen? Monotonic, owner-scoped, never
   * cleared — it survives a `rehydrate()` and a Lexical remount, which is the
   * whole point (see `collab-session.ts`). Consumers use it to refuse to paint
   * a loading state over text the user has already read; it says nothing about
   * whether that text is still current.
   */
  everRendered: boolean;
  /**
   * This binding's hydration state (stage 4) — where the session is between
   * "the replica exists" and "what the user sees provably equals what that
   * replica holds". Reactive; see `collab-session.ts` for the machine.
   *
   * Consumers use it for the PLACEHOLDER and the stalled Retry only. The write
   * gate it implies (the projection and the transport flush) is enforced inside
   * the seam and the transport, not by whoever renders this.
   */
  hydration: SessionState;
  /**
   * Report what the binding renders, in the Yjs basis
   * (`$xmlBasisContentLength`), at a `COLLABORATION_TAG` commit — the ONLY
   * thing that can promote `hydrating` to `hydrated`. `promoteOnly` is for a
   * listener that may have registered LATE (a commit already fired): it may
   * confirm agreement, never conclude disagreement.
   */
  verifyRendered: (shownLength: number, promoteOnly?: boolean) => void;
  /**
   * The block's prose durability, straight off the provider (`useSyncExternalStore`).
   * Report it to the surface's sync-status cloud — the transport is the only
   * thing that knows whether the bytes landed.
   */
  saveState: CollabSaveState;
  /** Re-run a save the user retried. Only meaningful while `saveState.phase === "error"`. */
  retrySave: () => void;
}

/**
 * Bind a block to its shared per-block content doc. Returns the
 * `providerFactory` for `CollaborationPlugin` (pass `id={blockId}` and
 * `shouldBootstrap={false}` — the doc is seeded server-side, never
 * bootstrapped by Lexical) plus this block's live save state.
 *
 * `dataText` (the block's `data.text`) is only ever read when the block has no
 * stored content doc yet: the first opener builds a throwaway seed from it via
 * the SAME runs↔XmlText bridge the rest of the system uses (registered token
 * extensions + decorator node classes), POSTs it to the first-writer-wins
 * doc-init endpoint, and the live doc is hydrated exclusively from the
 * server's authoritative response.
 *
 * `rowTruth` (`row-truth.ts`) is what this client knows about the block id in
 * server truth. `"present"` (the id is in the AUTHORITATIVE, not overlaid,
 * blocks data) lifts the doc-init FK gate (Stage 4a): a freshly created / split
 * block mounts from the overlay before its `_blocks` row exists server-side;
 * seeding then would FK-violate. The gate lifts push-based — the same blocks
 * push that confirms the row re-renders the consumer with `"present"`, and the
 * effect below unlatches the provider. Local edits made in the gap buffer in
 * the doc and flush after the seed completes.
 *
 * The RENDER-TIME value additionally seeds the provider's construction (the
 * first session over a block mints its owner): connect()'s instant pre-seed
 * discriminator must be accurate at the first connect — which may run before
 * any of this hook's effects — so only an `"unseen"` block (one this client
 * has never seen in server truth) pre-applies its `data.text` seed. An
 * existing block (`"present"`) and a re-created one (`"removed"` — every
 * delete is a trash, so its stored doc survives) both wait for the
 * subscription, which is what closes the reopen / restore text-duplication
 * hazard while a client-minted block still hydrates instantly.
 *
 * `projectText` is the row writer the seam-owned `content doc → data.text`
 * projection dispatches through. The projection itself lives HERE, not in the
 * consumer: its value is read out of the canonical doc, so it needs no editor —
 * and its final flush must run inside this hook's teardown, before the session
 * ends. Its argument is branded `DocSourcedRuns`, which only
 * `projectableRunsOf` can mint, so a future consumer cannot re-route a
 * view-sourced value through it.
 *
 * `onRunsEdit` (optional) fires once per closed local editing run (the run
 * tracker's idle window) with the block's runs before and after it — remote
 * applies abort a run rather than enter one, replays never open one, and
 * `untracked` surgeries are invisible to it. Pass a stable callback
 * (`useEventCallback`).
 */
/**
 * What a consumer reads off the live session in ONE `useSyncExternalStore`
 * snapshot: where the session is, and whether this block's text has ever been
 * on screen. Two facts, one store — a second store over the same listener
 * channel would tear (a snapshot pair sampled across a notify) for no benefit.
 *
 * Frozen and cached (see {@link CollabDocHold.hydrationState}): `getSnapshot`
 * MUST return the same reference while nothing moved, or `useSyncExternalStore`
 * loops.
 */
interface HydrationSnapshot {
  readonly state: SessionState;
  readonly everRendered: boolean;
}

/** The snapshot before any session exists (a render before any effect ran). */
const ATTACHING_SNAPSHOT: HydrationSnapshot = Object.freeze({
  state: ATTACHING_STATE,
  everRendered: false,
});

/** A hook instance's {@link CollabSession} handle (both doc hooks). */
interface CollabDocHold {
  /**
   * The live session for `id`, starting one on first call and RETAINING it
   * (cancelling a pending end) on every later one — the remount-in-place path.
   * Safe to call from effects.
   */
  ensure: (id: string) => CollabSession;
  /** The current live session, WITHOUT starting one. Null before first `ensure`. */
  peek: () => CollabSession | null;
  /**
   * End the current session and start its successor over the same owner: THE
   * recovery verb (see {@link CollabBlockDoc.rehydrate} and
   * `collab-session.ts`). Returns false when there is no live session to
   * recover — nothing is mounted, so there is nothing that could be behind.
   */
  restartSession: () => boolean;
  /**
   * The session's per-binding {@link BindingReplica} over `id`'s owner, minted
   * lazily on first call (the providerFactory call). One replica per session.
   */
  ensureReplica: (id: string) => BindingReplica;
  /**
   * Mark the block's row stale and arm ONE trailing projection window. Wired to
   * the canonical doc's `update` event; see {@link useCollabDocHold}.
   */
  armProjection: () => void;
  /** Subscribe to canonical-doc updates (see {@link CollabBlockDoc.subscribeDocUpdates}). */
  subscribeDocUpdates: (cb: () => void) => () => void;
  /** Has the transport's authoritative answer landed? (see {@link CollabBlockDoc.isSynced}) */
  isSynced: () => boolean;
  /** Subscribe to the transport's `sync` announcement (see {@link CollabBlockDoc.subscribeSync}). */
  subscribeSync: (cb: () => void) => () => void;
  /**
   * The live session's hydration snapshot, or {@link ATTACHING_SNAPSHOT} before
   * one exists. A `useSyncExternalStore` pair whose subscription survives
   * session churn: {@link CollabDocHold.ensure} /
   * {@link CollabDocHold.restartSession} re-point ONE forwarding listener at the
   * new session, so a consumer never re-subscribes and never misses a
   * transition across a `rehydrate()`.
   */
  hydrationState: () => HydrationSnapshot;
  subscribeHydration: (cb: () => void) => () => void;
  /** {@link CollabSession.verifyRendered} against the live session, if any. */
  verifyRendered: (shownLength: number, promoteOnly?: boolean) => void;
}

/**
 * Shared per-hook session handle (both doc hooks). Owns the `data.text` seed
 * builder, the render-accurate `RowTruth` construction value, the one
 * session and its unmount end — and the `content doc → data.text` PROJECTION,
 * which lives here because its final flush reads the canonical doc and must
 * therefore run inside this hook's own teardown, BEFORE the session ends.
 * The owner lives in the subtree's transport's registry (`useBlockDocs()`);
 * `serverSync` selects its provider when it is created — synced with that
 * transport's server, or purely local for the in-memory editor.
 */
function useCollabDocHold(
  blockId: string,
  dataText: unknown,
  rowTruth: RowTruth,
  serverSync: boolean,
  projectText: ProjectTextFn,
): CollabDocHold {
  const docs = useBlockDocs();
  const dataTextRef = useLatestRef(dataText);
  // Render-accurate row truth for provider CONSTRUCTION (the server provider's
  // pre-seed discriminator and FK gate): an existing block renders `"present"`
  // (it only renders because it is in the authoritative rows), a freshly
  // split/inserted block `"unseen"`, a re-created one `"removed"`.
  // `useLatestRef` writes during render, so every `ensure()` call site (all
  // effects) reads the value of the commit it runs in — never a stale default
  // the later latch effect would have to correct after connect() pre-seeded.
  // Irrelevant on the local path (no stored doc can exist).
  const rowTruthRef = useLatestRef(rowTruth);

  const buildSeedState = useEventCallback((): Uint8Array =>
    buildSeedStateFor(dataTextRef.current),
  );

  // ONE session per hook instance, started lazily from whichever consumer runs
  // first (the providerFactory call or a subscription effect) — both run in
  // effects, so a discarded render never leaks a session.
  //
  // `id` is a PARAMETER, not a captured `blockId`: `ensure` is a stable
  // `useEventCallback`, so every caller's dependence on the block id would
  // otherwise be invisible — to a reader and to `exhaustive-deps` alike.
  const sessionRef = useRef<CollabSession | null>(null);

  // --- The `content doc → data.text` projection ------------------------------
  //
  // Trigger: every canonical-doc update (local AND server-applied — push-based,
  // never a poll), debounced to one trailing write. VALUE: runs read back OUT of
  // the canonical doc (`projectableRunsOf`), never a serialization of the bound
  // editor — the editor is a VIEW that can silently fall behind its owner, and a
  // view may not overwrite the source it disagrees with. The `DocSourcedRuns`
  // brand on `projectText` is what keeps that true (see `doc-sourced-runs.ts`).
  //
  // The write goes through `projectText`: NOT recorded on the undo stack (Yjs
  // owns text history) and never echoed into any editor (they are bound to the
  // doc; `data.text` is only read once, as the doc-init seed). Skip-if-unchanged
  // keeps no-op churn out of `blocksChanged`. Multiple connected clients each
  // project the same runs — idempotent/convergent, accepted for the
  // my-devices+agents concurrency target.
  const projectTextRef = useLatestRef(projectText);
  const projectionDirtyRef = useRef(false);
  const projectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushProjection = useEventCallback(
    (opts?: { final?: boolean }): void => {
      if (projectionTimerRef.current !== null) {
        clearTimeout(projectionTimerRef.current);
        projectionTimerRef.current = null;
      }
      // Only fires when a doc update marked us dirty — a doc nothing ever wrote
      // to (subscription pending) must NOT project its emptiness.
      if (!projectionDirtyRef.current) return;
      const session = sessionRef.current;
      if (
        session &&
        !session.isEnded &&
        !session.writeAllowed &&
        !opts?.final
      ) {
        // THE WRITE GATE (stage 4): this binding cannot yet prove that what the
        // user sees is what the doc holds, so nothing derived from that doc is
        // persisted. Stay DIRTY with no timer armed — `onSessionState` re-runs
        // this the moment the gate opens, push-based. The `final` teardown flush
        // is exempt: the session is going away, so deferring would drop the row's
        // last text rather than delay it.
        return;
      }
      projectionDirtyRef.current = false;
      if (!session || session.isEnded) {
        // Unreachable by construction: the ONLY thing that marks the projection
        // dirty is the doc-update observer, which holds the session, and the
        // teardown below flushes BEFORE ending it. Loud rather than silent — a
        // dropped flush is a row that silently lags its doc forever.
        throw new Error(
          `useCollabBlockDoc: pending projection for "${blockId}" with no live content-doc session`,
        );
      }
      const owner = session.owner;
      // The owner's memoized doc read: a flush landing on the same content
      // generation as another reader (a structural entry pinning this row's
      // text) shares one headless read. Still `DocSourcedRuns` — the memo only
      // ever holds what the sole producer produced.
      const runs = owner.runsNow();
      const current = coalesce(runsOf(dataTextRef.current));
      // Runs are canonical (coalesced, sorted marks), so JSON equality is exact.
      if (JSON.stringify(runs) === JSON.stringify(current)) return;
      projectTextRef.current(owner.blockId, runs);
    },
  );

  // Event-driven debounce: each doc update marks dirty and arms ONE trailing
  // timer (not reset per keystroke), so a continuous typing run projects at
  // most once per PROJECT_DEBOUNCE_MS instead of starving until a pause.
  const armProjection = useEventCallback((): void => {
    projectionDirtyRef.current = true;
    if (projectionTimerRef.current === null) {
      projectionTimerRef.current = setTimeout(
        () => flushProjection(),
        PROJECT_DEBOUNCE_MS,
      );
    }
  });

  // --- Hydration state, forwarded across session churn -----------------------
  //
  // ONE subscription onto whichever session is live, so consumers (the
  // placeholder's `useSyncExternalStore`) subscribe once and still see the
  // successor's transitions after a `rehydrate()` swapped the session out.
  const hydrationListenersRef = useRef(new Set<() => void>());
  const sessionStateUnsubRef = useRef<(() => void) | null>(null);

  const onSessionState = useEventCallback((): void => {
    // The gate may have just opened. A projection window that fired while it
    // was closed left the block dirty with NO timer armed — re-run it now,
    // push-based, instead of waiting for the next keystroke to re-arm one.
    if (projectionDirtyRef.current && projectionTimerRef.current === null) {
      flushProjection();
    }
    for (const cb of [...hydrationListenersRef.current]) cb();
  });

  /** Re-point the forwarding subscription at `session` (a start or a restart). */
  const bindSession = useEventCallback(
    (session: CollabSession): CollabSession => {
      sessionStateUnsubRef.current?.();
      sessionStateUnsubRef.current = session.subscribeState(onSessionState);
      onSessionState();
      return session;
    },
  );

  // The snapshot cache. A NEW object per `getSnapshot()` call would loop
  // `useSyncExternalStore`, so one is minted only when a field actually moved —
  // the same identity-stability contract the provider's save state keeps.
  const hydrationSnapshotRef = useRef<HydrationSnapshot>(ATTACHING_SNAPSHOT);

  const hydrationState = useEventCallback((): HydrationSnapshot => {
    const session = sessionRef.current;
    const state = session?.state ?? ATTACHING_STATE;
    const everRendered = session?.everRendered ?? false;
    const cached = hydrationSnapshotRef.current;
    if (cached.state === state && cached.everRendered === everRendered)
      return cached;
    const next = Object.freeze({ state, everRendered });
    hydrationSnapshotRef.current = next;
    return next;
  });

  const subscribeHydration = useEventCallback(
    (cb: () => void): (() => void) => {
      hydrationListenersRef.current.add(cb);
      return () => {
        hydrationListenersRef.current.delete(cb);
      };
    },
  );

  const verifyRendered = useEventCallback(
    (shown: number, promoteOnly?: boolean): void => {
      const session = sessionRef.current;
      if (session && !session.isEnded)
        session.verifyRendered(shown, promoteOnly);
    },
  );

  // ONE session per hook instance, started lazily from whichever consumer runs
  // first (the providerFactory call or a subscription effect) — both run in
  // effects, so a discarded render never leaks a session.
  //
  // `id` is a PARAMETER, not a captured `blockId`: `ensure` is a stable
  // `useEventCallback`, so every caller's dependence on the block id would
  // otherwise be invisible — to a reader and to `exhaustive-deps` alike.
  const ensure = useEventCallback((id: string): CollabSession => {
    const current = sessionRef.current;
    if (current && !current.isEnded && current.blockId === id) {
      // Same block, session still alive: RETAIN it — cancel any scheduled end.
      // This is the StrictMode / remount-in-place path, and it is why the end
      // is deferred at all: `CollaborationPlugin` does not re-call its
      // `providerFactory` on a simulated remount, so the very replica and
      // provider it already holds must survive (see `collab-session.ts`).
      current.retain();
      return current;
    }
    // A re-keyed hook, or a spent session (a genuine unmount → later remount of
    // the same hook instance, e.g. under Activity). Either way this session can
    // never be handed out again: end it and start a fresh one. `end()` is
    // idempotent and no-ops on an already-ended session.
    current?.end();
    const next = CollabSession.start(
      docs,
      id,
      buildSeedState,
      rowTruthRef.current,
      serverSync,
    );
    sessionRef.current = next;
    return bindSession(next);
  });

  const ensureReplica = useEventCallback((id: string): BindingReplica =>
    ensure(id).replicaForBinding(),
  );

  const subscribeDocUpdates = useEventCallback(
    (cb: () => void): (() => void) => {
      const doc = ensure(blockId).owner.doc;
      const notify = (): void => cb();
      doc.on("update", notify);
      return () => doc.off("update", notify);
    },
  );

  // Reads the OWNER's provider, which outlives every session over it — so a
  // `rehydrate()` swapping the session underneath is invisible here, exactly as
  // for `subscribeDocUpdates` above. (Its `isSynced` twin sits with `peek`.)
  const subscribeSync = useEventCallback((cb: () => void): (() => void) => {
    const provider = ensure(blockId).owner.provider;
    const notify = (): void => cb();
    provider.on("sync", notify);
    return () => provider.off("sync", notify);
  });

  useEffect(() => {
    return () => {
      // TEARDOWN ORDER IS EXPLICIT, and it is load-bearing: the final flush
      // (navigation, block removal) READS the canonical doc, so it must run
      // while this hook still holds its session. It used to survive only
      // because the consumer happened to declare its projection hook before
      // this one — a React hook-declaration-order coincidence that nothing
      // stated and nothing checked. Both halves now live here, in one cleanup,
      // in order. `projectText` no-ops when the row is already gone
      // (merge / delete).
      //
      // `end()` is THE single deferred teardown — replica and owner hold alike
      // (see `collab-session.ts`). The session reference is deliberately NOT
      // cleared: the next `ensure()` within the retention window must find it
      // to cancel the pending end, which is the whole StrictMode/remount
      // survival mechanism.
      flushProjection({ final: true });
      sessionStateUnsubRef.current?.();
      sessionStateUnsubRef.current = null;
      sessionRef.current?.end();
    };
  }, [blockId, flushProjection]);

  // `peek` is the non-starting read of the current session: `getSaveState`
  // must not mint an owner from a render-phase `useSyncExternalStore` probe.
  // A spent session reads as none — it owns nothing any more.
  const peek = useEventCallback((): CollabSession | null => {
    const session = sessionRef.current;
    return session && !session.isEnded ? session : null;
  });

  // No session yet ⇒ not synced: nothing has been asked for, so nothing can
  // have answered. The honest reading, and the one that keeps a starvation
  // verdict from ever being drawn against a request that was never made.
  const isSynced = useEventCallback(
    (): boolean => peek()?.owner.provider.isSynced ?? false,
  );

  const restartSession = useEventCallback((): boolean => {
    const session = peek();
    if (!session) return false;
    sessionRef.current = bindSession(session.restart());
    return true;
  });

  return {
    ensure,
    peek,
    restartSession,
    ensureReplica,
    armProjection,
    subscribeDocUpdates,
    isSynced,
    subscribeSync,
    hydrationState,
    subscribeHydration,
    verifyRendered,
  };
}

/**
 * The two content-doc observer effects shared by both hooks: the projection
 * observer (`doc.on("update")`) and the run-tracker subscription. Storage-
 * agnostic — a local doc's updates and runs surface identically.
 *
 * Both observe the CANONICAL doc, deliberately — never the session's binding
 * replica. Every replica edit relays into the canonical synchronously, so the
 * canonical sees the union of all bindings' edits (a replica sees only its own
 * plus relays), and the projection/undo semantics are identical whether one
 * or five editors of the block are mounted.
 */
function useDocObservers(
  blockId: string,
  ensure: (id: string) => CollabSession,
  armProjection: () => void,
  onRunsEdit?: (edit: BlockRunsEdit) => void,
): void {
  // Doc-content observer arming the projection. `doc.on("update")` fires once
  // per transaction for local AND server-applied changes — and only when the
  // transaction actually integrated something, so a redundant re-apply of state
  // the doc already holds arms nothing.
  useEffect(() => {
    const doc = ensure(blockId).owner.doc;
    const notify = () => armProjection();
    doc.on("update", notify);
    return () => doc.off("update", notify);
  }, [blockId, armProjection, ensure]);

  // The text-history channel: each closed run as `{before, after}` runs, from
  // the owner's run tracker, for the consumer to record as a data entry.
  useEffect(
    () =>
      onRunsEdit ? ensure(blockId).owner.onRunsEdit(onRunsEdit) : undefined,
    [blockId, onRunsEdit, ensure],
  );
}

/** The `providerFactory` `CollaborationPlugin` calls to fetch the block's doc + provider. */
function useProviderFactory(
  blockId: string,
  ensureReplica: (id: string) => BindingReplica,
): CollabProviderFactory {
  return useEventCallback(
    (id: string, yjsDocMap: Map<string, Doc>): Provider => {
      if (id !== blockId) {
        throw new Error(
          `useCollabBlockDoc: providerFactory id "${id}" != block id "${blockId}"`,
        );
      }
      // The binding gets the session's per-binding REPLICA, never the shared
      // canonical doc: a binding must attach to an empty doc and hydrate from
      // post-attach events (see `binding-replica.ts` and the module comment).
      const replica = ensureReplica(blockId);
      // CollaborationPlugin reads the doc back out of the map it hands us.
      yjsDocMap.set(id, replica.replicaDoc);
      return replica;
    },
  );
}

/**
 * OUT (observability), shared by both hooks: the provider's derived save state,
 * for the surface's sync-status cloud. Keyed on `blockId` so a re-keyed hook
 * resubscribes to the NEW provider's listener set instead of staying bound to
 * the old owner's. `getSnapshot` tolerates "no session yet" (a first render,
 * before any effect has called `ensure()`): nothing has been typed, so nothing
 * can be unsaved. The provider memoizes its snapshot, so this can't loop.
 *
 * On the local transport this is permanently {@link IDLE_SAVE_STATE} — nothing
 * to save, nothing to retry — which the cloud aggregates to silence.
 */
function useSaveState(
  blockId: string,
  { ensure, peek }: CollabDocHold,
): Pick<CollabBlockDoc, "saveState" | "retrySave"> {
  const subscribeSaveState = useCallback(
    (onStoreChange: () => void) =>
      ensure(blockId).owner.provider.onSaveState(onStoreChange),
    [blockId, ensure],
  );
  const getSaveState = useCallback(
    (): CollabSaveState =>
      peek()?.owner.provider.getSaveState() ?? IDLE_SAVE_STATE,
    [peek],
  );
  const saveState = useSyncExternalStore(subscribeSaveState, getSaveState);
  const retrySave = useEventCallback((): void => {
    peek()?.owner.provider.retryFlush();
  });
  return { saveState, retrySave };
}

/**
 * The hydration-recovery surface shared by both hooks: read the canonical doc,
 * and put a block that lost hydration back together. `attachGeneration` is
 * state (not a ref) precisely because its only job is to change a React key.
 */
function useRehydration(
  hold: CollabDocHold,
): Pick<
  CollabBlockDoc,
  | "attachGeneration"
  | "docContentLength"
  | "hasLocalEdits"
  | "rehydrate"
  | "refetch"
> {
  const [attachGeneration, setAttachGeneration] = useState(0);
  const { peek, restartSession } = hold;

  const docContentLength = useEventCallback((): number => {
    const session = peek();
    return session ? xmlTextContentLength(yDocContent(session.owner.doc)) : 0;
  });

  const hasLocalEdits = useEventCallback(
    (): boolean => peek()?.owner.provider.hasLocalEdits ?? false,
  );

  const rehydrate = useEventCallback((): void => {
    // ONE verb: a new session structurally IS a fresh empty replica plus an
    // authoritative re-read, so recovery and a normal attach are the same code
    // path and nothing here has to guess which side was short (see
    // `collab-session.ts`). The only remaining half is the React key — Lexical
    // builds its binding exactly once per mount behind a ref, so a changed key
    // is the only thing that re-attaches a binding.
    if (restartSession()) setAttachGeneration((g) => g + 1);
  });

  const refetch = useEventCallback((): void => {
    // The other half of `rehydrate()`, on its own: the authoritative re-read,
    // without the fresh empty replica. The doc-init round trip is idempotent
    // (first-writer-wins) and lands as a Yjs MERGE into the live canonical doc,
    // so the replica, the binding and everything on screen are untouched — the
    // text does not blink out, and a false positive costs one request.
    peek()?.owner.provider.rehydrateFromServer();
  });

  return {
    attachGeneration,
    docContentLength,
    hasLocalEdits,
    rehydrate,
    refetch,
  };
}

/**
 * OUT (observability), shared by both hooks: this binding's live hydration
 * snapshot — the session's state AND the block's `everRendered` latch — for the
 * placeholder and the stalled Retry. Subscribed through the hold's ONE
 * forwarding listener, so a `rehydrate()` that swaps the session underneath is
 * invisible here: nothing re-subscribes and no transition is missed.
 * `getSnapshot` is identity-stable (a frozen snapshot replaced only when a
 * field actually moved; `ATTACHING_SNAPSHOT` covers "no session yet"), so
 * `useSyncExternalStore` cannot loop.
 */
function useHydrationState(hold: CollabDocHold): HydrationSnapshot {
  const { hydrationState, subscribeHydration } = hold;
  return useSyncExternalStore(subscribeHydration, hydrationState);
}

// The row read as what the provider should merge: see the call site.
function serverStateOf<S>(
  content: LiveRowResult<{ state: S }>,
): S | null | undefined {
  switch (content.status) {
    case "loading":
      return undefined;
    case "error":
      return content.stale?.state;
    case "ready":
      return content.found ? content.row.state : null;
  }
}

export function useCollabBlockDoc(
  blockId: string,
  dataText: unknown,
  rowTruth: RowTruth,
  projectText: ProjectTextFn,
  onRunsEdit?: (edit: BlockRunsEdit) => void,
): CollabBlockDoc {
  const hold = useCollabDocHold(blockId, dataText, rowTruth, true, projectText);
  const { ensure, armProjection, subscribeDocUpdates } = hold;
  useDocObservers(blockId, ensure, armProjection, onRunsEdit);

  // Doc-init FK gate (Stage 4a): unlatch the provider once the block's row is
  // server-confirmed (`"present"`). One-way — the provider ignores repeats —
  // and push-based: this effect re-fires on the authoritative blocks push that
  // confirms the row.
  useEffect(() => {
    if (rowTruth === "present")
      ensure(blockId).owner.provider.markBlockRowConfirmed();
  }, [blockId, rowTruth, ensure]);

  // IN: the per-block live row. Subscribing only while a block editor is
  // mounted is the lazy content-loading win; each pushed state flows into the
  // provider, which merges it (idempotently) into the shared doc.
  const content = useLiveRow(blockDocs, blockId);
  // While loading we can't tell "absent" (→ seed) from "not arrived yet", so
  // nothing is delivered until the row settles (`undefined`); `found: false`
  // is the positive "no doc yet" (`null`). A FAILED read is never "absent" —
  // seeding over a doc we could not read would fork it — so it delivers only
  // the state last seen (already merged; the merge is idempotent), else
  // nothing; live-state's resource-error sink reports the failure.
  const serverState = serverStateOf(content);
  useEffect(() => {
    if (serverState === undefined) return;
    ensure(blockId).owner.provider.onServerState(serverState);
    // Keyed on the state itself, so this fires once per actual server change
    // (the row's `updatedAt` only moves when its state does).
  }, [blockId, serverState, ensure]);

  const { saveState, retrySave } = useSaveState(blockId, hold);
  const providerFactory = useProviderFactory(blockId, hold.ensureReplica);
  const rehydration = useRehydration(hold);
  const hydration = useHydrationState(hold);
  return {
    providerFactory,
    saveState,
    retrySave,
    subscribeDocUpdates,
    isSynced: hold.isSynced,
    subscribeSync: hold.subscribeSync,
    hydration: hydration.state,
    everRendered: hydration.everRendered,
    verifyRendered: hold.verifyRendered,
    ...rehydration,
  };
}

/**
 * In-memory (`persist={false}`) twin of {@link useCollabBlockDoc}: binds a
 * block to a purely LOCAL {@link LocalYjsProvider} — the per-block `Y.Doc` is
 * seeded from `data.text` at connect() and NEVER touches the network (no
 * `blockDocs` row subscription — which would also require a
 * `NotificationsProvider` the demo doesn't mount — no doc-init/doc-update, no
 * FK gate). Typing, formatting, split, and merge all work locally; the doc
 * observers (projection + run tracker) fire exactly as on the server path, so
 * the projection writes runs into the in-memory store and text edits still ride
 * the unified undo stack. THE seam for how in-memory content docs "sync": they
 * don't — hence a permanently idle {@link CollabBlockDoc.saveState}.
 */
export function useLocalCollabBlockDoc(
  blockId: string,
  dataText: unknown,
  projectText: ProjectTextFn,
  onRunsEdit?: (edit: BlockRunsEdit) => void,
): CollabBlockDoc {
  // `RowTruth` is irrelevant with no server (no stored doc, no FK gate); pass
  // `"present"` so nothing is ever gated.
  const hold = useCollabDocHold(
    blockId,
    dataText,
    "present",
    false,
    projectText,
  );
  const { ensure, armProjection, subscribeDocUpdates } = hold;
  useDocObservers(blockId, ensure, armProjection, onRunsEdit);

  const { saveState, retrySave } = useSaveState(blockId, hold);
  const providerFactory = useProviderFactory(blockId, hold.ensureReplica);
  const rehydration = useRehydration(hold);
  // The SAME machine as the server path — never a fork. `serverSync: false`
  // makes every local session locally authoritative, so it reaches `hydrated`
  // inside its first synchronous `connect()` and `stalled` is unreachable.
  const hydration = useHydrationState(hold);
  return {
    providerFactory,
    saveState,
    retrySave,
    subscribeDocUpdates,
    // Permanently synced (the seed IS the answer, and it lands in connect()),
    // so the consumer's starvation arm is inert here rather than special-cased.
    isSynced: hold.isSynced,
    subscribeSync: hold.subscribeSync,
    hydration: hydration.state,
    everRendered: hydration.everRendered,
    verifyRendered: hold.verifyRendered,
    ...rehydration,
  };
}
