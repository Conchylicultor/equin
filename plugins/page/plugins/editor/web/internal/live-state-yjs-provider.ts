import { applyUpdate, encodeStateAsUpdate, mergeUpdates, type Doc } from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Provider, ProviderAwareness } from "@lexical/yjs";
import {
  EndpointError,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { subscribeWsStatus } from "@plugins/primitives/plugins/networking/web";
import {
  blockDocInit,
  blockDocUpdate,
} from "@plugins/page/plugins/editor-collab/core";
import type { RowTruth } from "./row-truth";

/**
 * `@lexical/yjs` {@link Provider} whose "network" is the app's existing
 * live-state + endpoints primitives instead of a Yjs wire protocol
 * (per-block CRDT plan, `research/2026-07-07-page-per-block-crdt-plan-b.md`,
 * Stage 2):
 *
 * - **in** — the per-block `blockDocs` live row (`useLiveRow`). The owning
 *   hook pushes each server value into {@link onServerState}; the provider
 *   `Y.applyUpdate`s it with itself as transaction origin. Idempotent and
 *   commutative, so the sender's own echo is a no-op and a concurrent remote
 *   edit lands as a *merge* — never a string rebuild, which is what makes
 *   fast typing caret-safe.
 * - **out** — `POST doc-init` (first-writer-wins seed) and debounced
 *   `POST doc-update` (incremental updates, merged per flush).
 *
 * Origin discipline (the echo guard): every server-applied update carries
 * `origin === this`, and `onDocUpdate` forwards only updates with any OTHER
 * origin (the `@lexical/yjs` binding, i.e. local edits) to the server. A
 * server echo therefore never round-trips back out.
 *
 * Seeding (the duplicate-seed hazard): when the block has no stored doc yet,
 * the provider POSTs a seed built from the block's `data.text` (built ONCE and
 * cached — `seedState`) and applies the server's authoritative response state
 * to the live doc. Seeds are DETERMINISTIC (content-hashed fixed clientID in
 * `use-collab-block-doc.ts`), so two clients seeding the same text produce
 * byte-identical updates and converge by no-op merge; different texts get
 * different clientIDs and can at worst duplicate, never corrupt. For a block
 * that CANNOT have a stored doc — one this client has never seen in server
 * truth (`RowTruth === "unseen"`, see `row-truth.ts`) — the seed is
 * additionally pre-applied LOCALLY at connect() — instant hydration, legacy
 * parity (see connect()).
 *
 * The pre-seed discriminator is {@link mayHaveStoredDoc}, DERIVED from what
 * this client has observed, never inferred from the row's confirmation. It used
 * to be "row unconfirmed ⇒ no `page_block_docs` row can exist (FK)", which was
 * true only while a block delete hard-deleted the doc with the row. Every
 * block delete is now a TRASH: the doc survives on the server, so a row
 * re-created optimistically (undo of a delete) is unconfirmed AND has a stored
 * doc — a seed pre-applied for it would merge with the surviving doc as a
 * second paragraph. Such a row is `"removed"`: it waits for the subscription's
 * answer like any existing block, and a positive `null` ("no doc") answer
 * pre-applies the seed at that moment (see {@link ingestServerState}) so a
 * restored never-opened block still renders after one round trip. Only
 * `"unseen"` — an id this client has never seen in server truth — pre-seeds at
 * connect(). Both facts are RENDER-ACCURATE (taken at the owning consumer's
 * render, threaded in at construction), so correctness never depends on
 * `CollaborationPlugin` happening to defer `connect()` past the owning hook's
 * effects — nothing in the provider contract orders them.
 *
 * Seed ordering (the doc-init FK race, Stage 4a): a freshly created / split
 * block mounts its editor from the OPTIMISTIC overlay before the structural
 * op's POST has created the `_blocks` row server-side — a doc-init fired at
 * that instant would hit the `page_block_docs → page_blocks` FK and 500.
 * Seeding is therefore gated on {@link markBlockRowConfirmed}: the owning hook
 * calls it once the block id appears in AUTHORITATIVE (server-truth, not
 * overlaid) blocks data, which the client already subscribes to — so the gate
 * lifts push-based, on the very push that confirms the row. Until then local
 * edits buffer in `pendingUpdates` and flush right after the seed completes.
 *
 * Offline resilience: a NETWORK-level seed/flush failure (fetch rejects — no
 * HTTP status) is an expected state, not a bug: the bytes stay queued in the
 * local doc / `pendingUpdates` and are retried push-based on the next
 * live-state socket reopen (ws-status bus), the next server push, or the next
 * local edit — never a retry timer. Unexpected HTTP errors still throw loudly.
 *
 * Save state (the sync-status seam): the provider is the ONLY place that knows
 * whether a block's prose is durable, so it publishes a derived
 * {@link CollabSaveState} through a fifth listener registry
 * ({@link onSaveState} / {@link getSaveState}, a `useSyncExternalStore` pair).
 * `syncing` while bytes are queued / debounced / in flight; `error` ONLY for a
 * real HTTP rejection (non-409 on flush, non-404 on init) — offline is
 * `syncing`, because those bytes are retried push-based and nothing is lost.
 * `blockGone` is `idle`: the bytes were deliberately dropped, their content
 * already moved with the merge.
 *
 * Doc-row loss (`doc-update` 409 after sync): never assume which of the two
 * causes it was. A doc-init probe arbitrates: 404 (block genuinely gone — a
 * trashed block was PURGED; a mere delete keeps the row and its doc, so a flush
 * racing a delete succeeds into the trashed doc, which is what undo restores)
 * is a quiet terminal stop; success (block alive, row unexpectedly gone)
 * recovers by re-creating the row from the FULL local doc state and resuming
 * flushes, with a loud console.error — a 409 can therefore never silently stop
 * a live block from saving.
 *
 * Teardown safety: the session's deferred end only finalizes the block's owner
 * when {@link readyForTeardown}; while buffered edits remain flushable the owner
 * is retained and the reconnect listeners (still subscribed until destroy)
 * drain the queue, then signal {@link setTeardownReadyListener} push-based.
 *
 * Awareness is a real `y-protocols` {@link Awareness} (CollaborationPlugin
 * requires a functional one for its focus tracking) but is never broadcast —
 * the concurrency target is one user's own tabs + agents, no live cursors.
 *
 * Events implemented (the exact set `CollaborationPlugin` listens for):
 * `sync` (isSynced) and `status` ({status}); `update`/`reload` are accepted
 * but never emitted (no doc reload in this transport).
 */

/**
 * Where a server-synced content doc's bytes go: the transport of the editor
 * that minted its owner, handed in at construction so a doc inside a scope (the
 * demo's browser server) seeds and flushes to THAT host, and resumes when THAT
 * host comes back — never the page's.
 */
export interface ContentDocTransport {
  /** The editor subtree's endpoint client — doc-init / doc-update. */
  readonly fetchEndpoint: FetchEndpoint;
  /**
   * The URL of the transport's live-state worktree socket
   * (`liveStateSocketUrl(transport, "worktree")`): its reopening on the
   * ws-status bus is the reconnect edge an interrupted seed or flush resumes
   * on.
   */
  readonly socketUrl: string;
}

/** Debounce window for batching local updates into one doc-update POST. */
const FLUSH_DEBOUNCE_MS = 300;

/**
 * The block's prose durability, as the sync-status cloud understands it:
 * `syncing` = local bytes not yet acknowledged by the server (queued, waiting
 * out the debounce, or in flight); `error` = the server durably REJECTED them
 * (a real HTTP status); `idle` = nothing outstanding. An offline/unreachable
 * server is `syncing`, never `error` — the bytes are retried push-based.
 */
export type CollabSavePhase = "idle" | "syncing" | "error";

/** Immutable, identity-stable save-state snapshot (a `useSyncExternalStore` value). */
export interface CollabSaveState {
  readonly phase: CollabSavePhase;
  /** When the queue last drained after a successful doc-update POST. */
  readonly lastFlushedAt: number | null;
}

/**
 * The snapshot a provider starts at, and the one the owning hook reports before
 * its first session starts (a render with no owner yet — nothing has been
 * typed, so nothing can be unsaved). A shared frozen constant so that
 * pre-session render also has a stable `getSnapshot()` identity.
 */
export const IDLE_SAVE_STATE: CollabSaveState = Object.freeze({
  phase: "idle" as const,
  lastFlushedAt: null,
});

/** Decode the wire base64 (see editor-collab's `stateToBase64`) to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class LiveStateYjsProvider implements Provider {
  private readonly doc: Doc;
  private readonly blockId: string;
  /** Builds the seed `Y.encodeStateAsUpdate` bytes from the block's `data.text`. */
  private readonly buildSeedState: () => Uint8Array;
  /** The endpoint client of the editor that minted this doc's owner. */
  private readonly fetchEndpoint: FetchEndpoint;
  // Real Awareness so CollaborationPlugin's initLocalState/focus tracking has
  // functional local state; it never leaves this client (nothing broadcasts it).
  private readonly _awareness: Awareness;

  private connected = false;
  private synced = false;
  private initStarted = false;
  private destroyed = false;
  /**
   * The seed bytes, built ONCE and reused for the local pre-apply AND every
   * doc-init attempt. One snapshot per provider is load-bearing: a retry that
   * rebuilt the seed from a since-updated `data.text` would post bytes that
   * differ from what was pre-applied locally — with the deterministic
   * content-hashed clientID they'd merge as duplication instead of a no-op.
   */
  private seedState: Uint8Array | null = null;
  /**
   * Did {@link preApplySeed} put the seed bytes into the live doc? Decides
   * what `doc-init` proposes when the doc already holds content: the cached
   * seed when it is what the doc holds (its echo is a no-op), else the doc
   * itself — see {@link initDoc}.
   */
  private seedPreApplied = false;
  /**
   * True once the block's row is known to exist in server truth — the doc-init
   * FK precondition (and ONLY that: the pre-seed discriminator is
   * {@link mayHaveStoredDoc}). Initialized from the owning consumer's
   * RENDER-TIME `RowTruth` (`"present"` — accurate at first render: existing
   * blocks only render because they are in the authoritative rows), then a
   * one-way latch lifted by {@link markBlockRowConfirmed} from the
   * authoritative blocks subscription (see the module comment).
   */
  private blockRowConfirmed: boolean;
  /**
   * Could a stored doc exist behind this block on the server? False only for
   * `RowTruth === "unseen"` — an id this client has never seen in server truth,
   * so nothing can have been stored for it. Immutable: the fact is about what
   * this client had observed when the owner was minted, and the pre-seed it
   * licenses happens once, at the first connect(). A `"removed"` row (its doc
   * may have survived a trash) and a `"present"` one both read true and wait
   * for the subscription (see the module comment).
   */
  readonly mayHaveStoredDoc: boolean;
  /**
   * Server-confirmed "the block row no longer exists" (doc-init 404):
   * terminal quiet stop — the content moved with a merge or went with the
   * delete, so buffered bytes are deliberately dropped and the provider is
   * finalizable.
   */
  private blockGone = false;
  /**
   * Recovery mode: the next doc-init must seed from the FULL local doc state
   * (never the `data.text` seed — that would be an independent encoding of
   * content the local doc already holds and merge as duplication). Set by both
   * recovery paths: the post-sync 409 (the doc row vanished under us) and
   * {@link rehydrateFromServer} (the reader lost its way).
   */
  private reinitFromLocalDoc = false;
  /**
   * The 409 half of {@link reinitFromLocalDoc}: the doc row vanished while the
   * block still lives, which no sanctioned path does. Kept separate so only
   * that path carries the loud "investigate what deleted the row" console
   * error — a `rehydrateFromServer` re-read is a recovery, not an anomaly in
   * the doc store.
   */
  private docRowVanished = false;
  /**
   * Has any LOCAL edit ever entered this doc (any update whose origin is not
   * this provider — i.e. the binding)? The discriminator for the starvation
   * check in `collab-text-plugin`: "the row holds text my doc does not" is
   * proof this client is behind the server ONLY for a doc nobody here has
   * edited. A doc the user just emptied legitimately trails its own ~1s row
   * projection, and must not be mistaken for one that never received anything.
   */
  private everEdited = false;
  /** Latest value from the live subscription (undefined until first load). */
  private serverState: string | null | undefined = undefined;
  /** Last applied wire state — skips redundant decode+apply on echoes. */
  private lastAppliedState: string | null = null;

  private pendingUpdates: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight = false;
  /**
   * How many sessions currently hold the OUTBOUND flush closed because their
   * hydration is unproven (stage 4's write gate — see `collab-session.ts`).
   * Refcounted because one block's owner is shared by every mounted binding of
   * it. A held queue is DEFERRED, never dropped: bytes stay in
   * {@link pendingUpdates}, the save state stays `syncing`, and the last
   * release resumes the drain push-based.
   */
  private flushHolds = 0;
  /** One offline warning per outage episode (reset on the next success). */
  private offlineWarned = false;
  /**
   * The last DURABLE rejection: a real HTTP status the transport could not
   * arbitrate away (non-409 on doc-update, non-404 on doc-init). A
   * network-level rejection is deliberately NOT stored — those bytes retry
   * push-based and are not lost, so they read as `syncing` (see the module
   * comment). Cleared on the next success and by {@link retryFlush}.
   */
  private lastError: EndpointError | null = null;
  /** Stamped when the queue drains after a successful doc-update POST. */
  private lastFlushedAt: number | null = null;
  /**
   * Memoized {@link CollabSaveState}: `getSaveState` must return a stable
   * identity while nothing changed, or a `useSyncExternalStore` consumer loops.
   * Replaced ONLY by {@link emitSaveState}, which is called at every transition
   * point of the four inputs (`pendingUpdates` / `flushTimer` / `flushInFlight`
   * / `lastError`, plus `blockGone` and `lastFlushedAt`).
   */
  private saveState: CollabSaveState = IDLE_SAVE_STATE;
  private readonly unsubscribeWsStatus: () => void;
  /**
   * Single-slot teardown notifier (owner-owned): invoked whenever the
   * provider BECOMES ready-for-teardown, so a deferred finalize that found
   * buffered edits can complete push-based once they drain (see
   * {@link readyForTeardown}).
   */
  private teardownReadyListener: (() => void) | null = null;

  private readonly syncListeners = new Set<(isSynced: boolean) => void>();
  private readonly statusListeners = new Set<
    (arg: { status: string }) => void
  >();
  private readonly updateListeners = new Set<(arg: unknown) => void>();
  private readonly reloadListeners = new Set<(doc: Doc) => void>();
  private readonly saveStateListeners = new Set<() => void>();
  private readonly blockGoneListeners = new Set<() => void>();

  constructor(
    doc: Doc,
    blockId: string,
    buildSeedState: () => Uint8Array,
    rowTruth: RowTruth,
    transport: ContentDocTransport,
  ) {
    this.doc = doc;
    this.blockId = blockId;
    this.buildSeedState = buildSeedState;
    this.fetchEndpoint = transport.fetchEndpoint;
    this.blockRowConfirmed = rowTruth === "present";
    this.mayHaveStoredDoc = rowTruth !== "unseen";
    this._awareness = new Awareness(doc);
    doc.on("update", this.onDocUpdate);
    // Reconnect signals (push-based, no polling): resume whatever an outage
    // interrupted — an incomplete seed or a buffered local-edit queue — on
    // either network-back edge:
    //  - the transport's live-state worktree socket reopening (covers server restarts,
    //    where navigator.onLine never changed; HTTP and the WS ride the same
    //    gateway, so "socket reopened" implies endpoints are reachable again);
    //  - the browser's `online` event (covers actual connectivity loss, where
    //    an idle WS may not surface a close promptly).
    const { socketUrl } = transport;
    this.unsubscribeWsStatus = subscribeWsStatus((ev) => {
      if (ev.status !== "open" || ev.url !== socketUrl) return;
      this.onTransportReconnected();
    });
    window.addEventListener("online", this.onBrowserOnline);
  }

  private readonly onBrowserOnline = (): void => {
    this.onTransportReconnected();
  };

  get awareness(): ProviderAwareness {
    // y-protocols' `Awareness` types its states as generic records while
    // `@lexical/yjs` narrows them to `UserState`; the shapes are runtime-
    // compatible (Awareness stores whatever `initLocalState` writes) and this
    // is the standard y-protocols ↔ Lexical pairing. The cast bridges the
    // third-party declaration gap — there is no local type to fix.
    return this._awareness as unknown as ProviderAwareness;
  }

  // --- Provider interface ---------------------------------------------------

  connect(): void {
    this.connected = true;
    this.emitStatus("connected");
    if (this.synced) {
      // Reconnect (e.g. StrictMode disconnect→connect): re-announce sync so
      // CollaborationPlugin's onSync bookkeeping re-runs against the live doc.
      this.emitSync(true);
      return;
    }
    // INSTANT local hydration for a client-minted block (Stage 4a): this
    // client has never seen the block id in server truth (`!mayHaveStoredDoc`),
    // so nothing can be stored for it and pre-applying the seed cannot collide
    // with any stored state — the editor shows the split tail / empty
    // paragraph IMMEDIATELY, exactly like the legacy synchronous hydration,
    // instead of staying empty for the confirm-push + doc-init round trips
    // (during which typing/Enter would interact with a half-hydrated doc). The
    // seed is DETERMINISTIC (content-hashed fixed clientID — see
    // `use-collab-block-doc.ts`), so the eventual authoritative state (our own
    // doc-init echo, or a racing tab's byte-identical seed) merges as a no-op.
    // `mayHaveStoredDoc` is immutable and render-accurate — an existing block
    // is `"present"` and a re-created one `"removed"` from their very first
    // render, so this branch is structurally unreachable for both regardless
    // of when CollaborationPlugin calls connect() relative to the owning hook's
    // effects. A subscription that already answered (`serverState` defined,
    // even `null`) is handled by `ingestServerState` below, which owns the
    // "positive absent answer" pre-seed. connect() runs right after the binding
    // attaches and before the user can type, so the store-empty guard holds in
    // practice; it is checked anyway.
    if (
      !this.mayHaveStoredDoc &&
      this.serverState === undefined &&
      this.doc.store.clients.size === 0
    ) {
      this.preApplySeed();
    }
    // First value not in yet — onServerState completes the handshake when the
    // subscription delivers it (push-based; never polled). A value that ALREADY
    // arrived was held (see onServerState) and is applied here, now that the
    // binding is listening.
    this.ingestServerState();
  }

  /** Apply the (cached, deterministic) seed to the live doc, provider-origin. */
  private preApplySeed(): void {
    this.seedState ??= this.buildSeedState();
    applyUpdate(this.doc, this.seedState, this);
    this.seedPreApplied = true;
  }

  disconnect(): void {
    this.connected = false;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush pending local edits eagerly on teardown (skip the debounce window)
    // so an unmount mid-typing-run never strands the last keystrokes.
    if (this.synced && this.pendingUpdates.length > 0) void this.flushLoop();
    this.emitStatus("disconnected");
    this.emitSaveState(); // the cleared debounce timer may have been the only "syncing" input
  }

  on(type: "sync", cb: (isSynced: boolean) => void): void;
  on(type: "status", cb: (arg: { status: string }) => void): void;
  on(type: "update", cb: (arg: unknown) => void): void;
  on(type: "reload", cb: (doc: Doc) => void): void;
  on(
    type: "sync" | "status" | "update" | "reload",
    cb:
      | ((isSynced: boolean) => void)
      | ((arg: { status: string }) => void)
      | ((arg: unknown) => void)
      | ((doc: Doc) => void),
  ): void {
    if (type === "sync")
      this.syncListeners.add(cb as (isSynced: boolean) => void);
    else if (type === "status")
      this.statusListeners.add(cb as (arg: { status: string }) => void);
    else if (type === "update")
      this.updateListeners.add(cb as (arg: unknown) => void);
    else this.reloadListeners.add(cb as (doc: Doc) => void);
  }

  off(type: "sync", cb: (isSynced: boolean) => void): void;
  off(type: "status", cb: (arg: { status: string }) => void): void;
  off(type: "update", cb: (arg: unknown) => void): void;
  off(type: "reload", cb: (doc: Doc) => void): void;
  off(
    type: "sync" | "status" | "update" | "reload",
    cb:
      | ((isSynced: boolean) => void)
      | ((arg: { status: string }) => void)
      | ((arg: unknown) => void)
      | ((doc: Doc) => void),
  ): void {
    if (type === "sync")
      this.syncListeners.delete(cb as (isSynced: boolean) => void);
    else if (type === "status")
      this.statusListeners.delete(cb as (arg: { status: string }) => void);
    else if (type === "update")
      this.updateListeners.delete(cb as (arg: unknown) => void);
    else this.reloadListeners.delete(cb as (doc: Doc) => void);
  }

  // --- Save state (the sync-status seam) ------------------------------------

  /**
   * Subscribe to save-state transitions. Returns an unsubscribe. Bound arrow so
   * its identity is stable across renders — pass it straight to
   * `useSyncExternalStore`.
   */
  readonly onSaveState = (cb: () => void): (() => void) => {
    this.saveStateListeners.add(cb);
    return () => {
      this.saveStateListeners.delete(cb);
    };
  };

  /** The memoized snapshot — same reference until something actually changed. */
  readonly getSaveState = (): CollabSaveState => this.saveState;

  /**
   * Re-run a flush the user asked to retry (the cloud's Retry button). Clears
   * the durable error so the phase leaves `error`, then resumes whichever half
   * of the pipeline stalled: a failed init (its `initStarted` latch is already
   * re-armed by `initDoc`'s catch) or a failed flush. Push-based, never a timer.
   */
  readonly retryFlush = (): void => {
    if (this.destroyed || this.blockGone) return;
    this.lastError = null;
    this.emitSaveState();
    if (!this.synced) {
      this.maybeInit();
      return;
    }
    if (this.pendingUpdates.length > 0 && !this.flushInFlight)
      void this.flushLoop();
  };

  /**
   * `blockGone` first: the bytes were deliberately dropped, so nothing is at
   * risk regardless of what else is set. Then a durable rejection. Then anything
   * still owed to the server — queued, waiting out the debounce, or in flight.
   */
  private computeSavePhase(): CollabSavePhase {
    if (this.blockGone) return "idle";
    if (this.lastError !== null) return "error";
    if (
      this.pendingUpdates.length > 0 ||
      this.flushInFlight ||
      this.flushTimer !== null
    ) {
      return "syncing";
    }
    return "idle";
  }

  /**
   * Recompute and publish. Idempotent: when neither the phase nor
   * `lastFlushedAt` moved, the snapshot reference is untouched and no listener
   * fires — which is what keeps `useSyncExternalStore` from looping and lets
   * every transition point call this unconditionally.
   */
  private emitSaveState(): void {
    const phase = this.computeSavePhase();
    if (
      this.saveState.phase === phase &&
      this.saveState.lastFlushedAt === this.lastFlushedAt
    ) {
      return;
    }
    this.saveState = Object.freeze({
      phase,
      lastFlushedAt: this.lastFlushedAt,
    });
    for (const cb of [...this.saveStateListeners]) cb();
  }

  // --- Server → local (fed by the owning hook's live subscription) ----------

  /**
   * Deliver the latest `blockDocs` row: the stored base64 state,
   * or `null` when the block has no doc row yet (first-ever open → seed).
   * Called on every push; `Y.applyUpdate` idempotency makes echoes no-ops.
   */
  onServerState(state: string | null): void {
    if (this.destroyed) return;
    this.serverState = state;
    // HOLD until connected — never apply into a doc no binding is watching.
    // `@lexical/yjs` ingests the doc EXCLUSIVELY through the `observeDeep`
    // events its binding registers on mount; it never reads a doc that already
    // holds content (`createBinding` starts from an empty CollabElementNode and
    // `shouldBootstrap` only ever inserts an empty paragraph). Bytes applied
    // before the binding attaches are therefore invisible to the editor
    // FOREVER — `lastAppliedState` makes the re-apply a no-op, and Yjs emits no
    // event for a state it already holds, so no later push can heal it.
    //
    // This is not hypothetical timing paranoia: it is the warm-navigation path.
    // Re-opening a page whose `page-block-doc` value is still cached settles the
    // subscription on the FIRST render, so the owning hook's effect calls this
    // before `CollaborationPlugin` has created its binding (which costs two more
    // render passes) — every block rendered empty until a reload. `connect()`
    // runs after the binding's observer is registered, which is precisely why
    // the apply belongs there.
    if (this.connected) this.ingestServerState();
    // Push-driven flush retry: a queue left behind by a transient network
    // failure (no armed debounce timer) drains on the next server push instead
    // of waiting for the next local keystroke. During normal typing the
    // debounce timer is armed, so this never bypasses the batching window.
    if (
      this.synced &&
      this.pendingUpdates.length > 0 &&
      this.flushTimer === null &&
      !this.flushInFlight
    ) {
      void this.flushLoop();
    }
  }

  /**
   * Apply the latest subscription value to the live doc. Called ONLY while
   * connected — i.e. with the binding's `observeDeep` observer registered, so
   * the resulting Yjs update events actually reach Lexical (see onServerState).
   * `Y.applyUpdate` idempotency + `lastAppliedState` make repeat calls no-ops.
   */
  private ingestServerState(): void {
    const state = this.serverState;
    if (state === undefined) return; // first value not in yet
    if (state === null) {
      // No stored doc — a POSITIVE answer, not a pending one. For a block whose
      // row is not yet confirmed (a re-created `"removed"` row whose doc did
      // not survive — purged, or never opened — or an `"unseen"` block whose
      // subscription answered before connect()) the seed cannot be posted yet
      // (FK gate), but it CAN be shown: nothing is stored, so pre-applying the
      // deterministic seed collides with nothing, and the doc-init that the
      // confirmation push later triggers carries these exact bytes and merges
      // back as a no-op. Without this a restored never-opened block would sit
      // empty for the confirmation AND the doc-init round trips.
      if (!this.blockRowConfirmed && this.doc.store.clients.size === 0) {
        this.preApplySeed();
      }
      // Seed exactly once (first-writer-wins server-side). After a successful
      // init this is normally unreachable (doc-init is the only row creator,
      // and a doc row dies only at purge — a delete keeps it) — except the
      // post-409 recovery state, where `synced` was reset and maybeInit re-runs
      // the init in from-local-doc mode.
      this.maybeInit();
      return;
    }
    if (state !== this.lastAppliedState) {
      this.lastAppliedState = state;
      applyUpdate(this.doc, base64ToBytes(state), this);
    }
    if (!this.synced) this.markSynced();
  }

  /**
   * The doc-init existence gate (see the module comment): the owning hook
   * calls this once the block id is present in AUTHORITATIVE blocks data.
   * One-way latch; lifting it retries a seed that was gated (or that failed
   * transiently and re-armed).
   */
  markBlockRowConfirmed(): void {
    if (this.blockRowConfirmed || this.destroyed) return;
    this.blockRowConfirmed = true;
    if (this.connected && !this.synced && this.serverState === null)
      this.maybeInit();
  }

  // --- Local → server --------------------------------------------------------

  /**
   * Forward local edits (any origin but this provider — i.e. the
   * `@lexical/yjs` binding's transactions) to the debounced flush queue.
   * Server-applied updates carry `origin === this` and are never echoed back.
   */
  private readonly onDocUpdate = (
    update: Uint8Array,
    origin: unknown,
  ): void => {
    if (origin === this) return;
    this.everEdited = true;
    this.pendingUpdates.push(update);
    this.scheduleFlush();
    // The keystroke edge: bytes now owed to the server ⇒ `syncing`, whether or
    // not scheduleFlush armed a timer (it doesn't before sync completes).
    this.emitSaveState();
  };

  // --- The hydration write gate (see `collab-session.ts`) --------------------

  /** Has the server's authoritative answer landed? (the sessions' sync gate) */
  get isSynced(): boolean {
    return this.synced;
  }

  /** Server-confirmed "the block no longer exists" — terminal (see the field). */
  get isBlockGone(): boolean {
    return this.blockGone;
  }

  onBlockGone(cb: () => void): () => void {
    this.blockGoneListeners.add(cb);
    return () => {
      this.blockGoneListeners.delete(cb);
    };
  }

  acquireFlushHold(): void {
    this.flushHolds += 1;
  }

  releaseFlushHold(): void {
    if (this.flushHolds <= 0) {
      // More releases than holds — a session lifetime bug upstream. Loud rather
      // than a negative refcount that would silently wedge the flush open.
      throw new Error(
        `LiveStateYjsProvider("${this.blockId}"): releaseFlushHold() without a matching acquire`,
      );
    }
    this.flushHolds -= 1;
    if (this.flushHolds > 0 || this.destroyed || !this.synced) return;
    // Push-based resume: whatever the gate deferred drains now, no timer.
    if (this.pendingUpdates.length > 0 && !this.flushInFlight)
      void this.flushLoop();
  }

  private get flushHeld(): boolean {
    return this.flushHolds > 0;
  }

  private scheduleFlush(): void {
    // Before sync/init completes, doc-update would 409 — the queue drains right
    // after markSynced instead.
    if (!this.synced || this.destroyed) return;
    // A session cannot prove its binding renders what its replica holds, so
    // nothing derived leaves this client yet. The bytes stay queued and
    // `emitSaveState` (called by the caller) keeps the cloud honest.
    if (this.flushHeld) return;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushLoop();
    }, FLUSH_DEBOUNCE_MS);
    this.emitSaveState();
  }

  /**
   * Single-flight drain of the pending-update queue: merge the batch into one
   * incremental update and POST it. On failure the merged bytes are re-queued
   * (the next local edit or flush retries them — no silent data loss) and the
   * error is rethrown so it surfaces loudly.
   */
  private async flushLoop(): Promise<void> {
    if (this.flushInFlight || this.flushHeld) return;
    const { fetchEndpoint } = this;
    this.flushInFlight = true;
    /** Did any doc-update POST land? Gates the `lastFlushedAt` stamp. */
    let posted = false;
    this.emitSaveState();
    try {
      while (this.pendingUpdates.length > 0 && this.synced) {
        const batch = this.pendingUpdates;
        this.pendingUpdates = [];
        const update = batch.length === 1 ? batch[0]! : mergeUpdates(batch);
        try {
          await fetchEndpoint(
            blockDocUpdate,
            { id: this.blockId },
            { body: new Blob([update as BlobPart]) },
          );
          posted = true;
          this.offlineWarned = false;
          this.lastError = null;
        } catch (err) {
          // 409 = "no doc row". We only flush AFTER a successful init/sync, so
          // the row existed — it vanished under us. Two causes with OPPOSITE
          // handling share this status, so never guess here:
          //  - the BLOCK is gone for good: a trashed block was PURGED, which
          //    cascades its doc row. (A mere delete is a trash and keeps the
          //    doc, so a flush racing a delete — e.g. Backspace-merge captures
          //    the live runs, appends them to the target, then structurally
          //    deletes this block — succeeds into the trashed doc, which is
          //    exactly what undo restores.) Nothing left to save — quiet stop.
          //  - the doc row vanished while the block still LIVES (unexpected):
          //    stopping would silently buffer this block's edits forever.
          // Re-arm the init path in from-local-doc mode and let doc-init
          // arbitrate AUTHORITATIVELY: it 404s iff the block row is absent
          // (→ terminal quiet stop via `blockGone`), otherwise it re-creates
          // the doc row from the FULL local doc state — nothing lost — and
          // the flush loop resumes (loudly flagged; see initDoc).
          if (err instanceof EndpointError && err.status === 409) {
            this.pendingUpdates.unshift(update);
            this.synced = false;
            this.initStarted = false;
            this.reinitFromLocalDoc = true;
            this.docRowVanished = true;
            this.maybeInit();
            return;
          }
          this.pendingUpdates.unshift(update);
          // Any HTTP response other than the arbitrated 409 above is a real
          // server-side rejection — the bytes are durably refused, so the cloud
          // must say so (and offer Retry). Surface it loudly too.
          if (err instanceof EndpointError) {
            this.lastError = err;
            throw err;
          }
          // Network-level failure (offline, server restarting): an EXPECTED
          // state for a local-first doc, not a bug — and therefore NOT an error
          // phase: the merged bytes are back at the queue head and the provider
          // stays `syncing` until a push-based retry lands them.
          // Retried push-based on socket-reopen / next server push / next local
          // edit. Warn once per episode so the console shows edits are
          // buffering.
          if (!this.offlineWarned) {
            this.offlineWarned = true;
            console.warn(
              `[collab] doc-update for block ${this.blockId} failed (offline?) — edits are buffered locally and will flush on reconnect`,
              err,
            );
          }
          return;
        }
      }
    } finally {
      this.flushInFlight = false;
      // "Saved" means the server acked every byte we owed it. Stamped only when
      // a POST actually landed AND the queue emptied — a 409 re-init, a
      // requeued offline batch, or a thrown rejection all leave bytes owed.
      if (posted && this.pendingUpdates.length === 0)
        this.lastFlushedAt = Date.now();
      // A drained queue may unblock a deferred destroy (see readyForTeardown).
      this.notifyTeardownReady();
      // Runs on every exit — drain, early `return`, and the rethrown rejection.
      this.emitSaveState();
    }
  }

  // --- Seed / sync ------------------------------------------------------------

  private maybeInit(): void {
    // FK-precondition gate (Stage 4a): never doc-init before the block's row
    // is server-confirmed — a premature seed would FK-fail. The confirmation
    // push lifts the gate via markBlockRowConfirmed.
    if (!this.blockRowConfirmed) return;
    if (this.initStarted || this.synced || this.destroyed || this.blockGone)
      return;
    this.initStarted = true;
    void this.initDoc();
  }

  /**
   * Re-read the server's authoritative state into the live doc, from scratch.
   *
   * The provider's whole recovery surface is otherwise WRITE-side (retryFlush,
   * the 409 re-init, teardown retention, the offline requeue): every failure it
   * anticipates is "bytes did not reach the server". This is the READ-side
   * counterpart — "bytes did not reach the editor" — and it exists because the
   * live-state push is the ONLY thing that ever hydrates a doc whose row was
   * created by somebody else, so a single missed `page-block-doc` push leaves
   * this doc permanently short of the server with no way to notice.
   *
   * Deliberately the SAME path as the 409 recovery rather than a second
   * mechanism: `doc-init` is idempotent first-writer-wins AND returns the
   * authoritative state, so it is simultaneously the re-read and the re-assert.
   * `reinitFromLocalDoc` keeps the seed honest (the full local doc, never a
   * `data.text` re-encoding that would merge as duplication), and `markSynced`
   * re-queues the local state so nothing this doc holds is dropped by the
   * round trip.
   */
  get hasLocalEdits(): boolean {
    return this.everEdited;
  }

  rehydrateFromServer(): void {
    if (this.destroyed || this.blockGone) return;
    this.synced = false;
    this.initStarted = false;
    this.reinitFromLocalDoc = true;
    this.maybeInit();
  }

  private async initDoc(): Promise<void> {
    const { fetchEndpoint } = this;
    const recovering = this.reinitFromLocalDoc;
    const rowVanished = this.docRowVanished;
    let seed: Uint8Array;
    if (
      this.doc.store.clients.size > 0 &&
      (recovering || !this.seedPreApplied)
    ) {
      // The LOCAL doc is the content, so it is the proposal. Two ways here:
      //  - post-409 recovery: the doc holds the stored state it already merged
      //    plus any unflushed edits;
      //  - the doc holds content that is NOT the seed — the user typed into a
      //    block whose subscription had not answered yet (a restored,
      //    never-opened `"removed"` row: `ingestServerState` skips the
      //    pre-seed once the doc has clients, precisely so the seed cannot
      //    land beside what they typed).
      // Seeding from `data.text` in either case would be an INDEPENDENT
      // encoding of content — the server would create the doc from it, and
      // its authoritative response would merge that paragraph in BESIDE the
      // doc's own, i.e. duplicated text.
      seed = encodeStateAsUpdate(this.doc);
    } else {
      // Seed bytes from the block's `data.text` — built once and cached (see
      // `seedState`). For a pre-seeded client-minted block these exact bytes
      // are already in the live doc; for everything else they are a throwaway
      // proposal and only the server's authoritative response is applied.
      // Either way first-writer-wins + the deterministic encoding mean racing
      // seeders converge instead of duplicating.
      this.seedState ??= this.buildSeedState();
      seed = this.seedState;
    }
    let res: { state: string };
    try {
      res = await fetchEndpoint(
        blockDocInit,
        { id: this.blockId },
        { body: new Blob([seed as BlobPart]) },
      );
    } catch (err) {
      // Whatever failed, the latch MUST re-arm: a wedged `initStarted` would
      // leave the block editable-but-never-synced until a remount (the exact
      // Stage-4a failure mode). The next trigger — confirmation push, server
      // push, socket reopen — retries the seed.
      this.initStarted = false;
      if (err instanceof EndpointError && err.status === 404) {
        // Block row gone — SERVER-CONFIRMED absence (doc-init's "block does
        // not exist": purged, since a delete is a trash and keeps the row
        // addressable to doc-init): nothing to sync, the editor is unmounting
        // (or already unmounted). Terminal quiet stop: drop the buffered bytes
        // deliberately (nothing exists to receive them) and let a deferred
        // destroy finalize.
        this.blockGone = true;
        this.pendingUpdates = [];
        this.notifyTeardownReady();
        this.emitSaveState(); // → idle: the dropped bytes are not at risk
        this.emitBlockGone(); // a replay waiting on `sync` stops waiting
        return;
      }
      if (err instanceof EndpointError) {
        // A real server-side rejection of the seed: the block can never sync.
        this.lastError = err;
        this.emitSaveState();
        throw err;
      }
      // Network-level failure: expected offline state (NOT an error phase); the
      // socket-reopen signal retries (see onTransportReconnected).
      if (!this.offlineWarned) {
        this.offlineWarned = true;
        console.warn(
          `[collab] doc-init for block ${this.blockId} failed (offline?) — will retry on reconnect`,
          err,
        );
      }
      return;
    }
    if (this.destroyed) return;
    this.offlineWarned = false;
    this.lastError = null;
    if (rowVanished) {
      this.docRowVanished = false;
      // The block is ALIVE yet its doc row had vanished — no sanctioned path
      // does that (a doc row dies only at purge, with its block). We recovered (row
      // re-created from the full local state, queue resumes below), but the
      // interleave itself is a bug somewhere — surface it loudly.
      console.error(
        `[collab] content doc row for block ${this.blockId} vanished while the block still exists — re-created it from the local doc state (no edits lost). This should not happen; investigate what deleted the row.`,
      );
    }
    if (res.state !== this.lastAppliedState) {
      this.lastAppliedState = res.state;
      applyUpdate(this.doc, base64ToBytes(res.state), this);
    }
    // A racing winner's push may have marked us synced already — markSynced
    // re-emitting is harmless (shouldBootstrap is false).
    this.markSynced();
  }

  /** Socket-reopen edge: resume an interrupted seed or drain a buffered queue. */
  private onTransportReconnected(): void {
    // Deliberately NOT gated on `connected`: a teardown-retained provider
    // (editor unmounted with buffered edits during an outage — the deferred
    // destroy is waiting on readyForTeardown) must still drain its queue on
    // reconnect, or the retained bytes would never flush.
    if (this.destroyed) return;
    if (!this.synced) {
      if (this.serverState === null || this.reinitFromLocalDoc)
        this.maybeInit();
      return;
    }
    if (this.pendingUpdates.length > 0 && !this.flushInFlight)
      void this.flushLoop();
  }

  private markSynced(): void {
    if (this.reinitFromLocalDoc) {
      // Recovery handshake completed (our own re-init, or a racing replica's
      // push re-created the row first). Whatever re-created the doc row may
      // lack updates this doc had flushed to the OLD row — enqueue the full
      // local state once; merging a full state is idempotent and restores
      // anything missing.
      this.reinitFromLocalDoc = false;
      this.pendingUpdates.push(encodeStateAsUpdate(this.doc));
    }
    this.synced = true;
    this.emitSync(true);
    if (this.pendingUpdates.length > 0) void this.flushLoop();
    // Covers the no-queue case (flushLoop, which emits, never runs) and the
    // recovery push above.
    this.emitSaveState();
  }

  // --- Lifecycle ---------------------------------------------------------------

  /**
   * True when destroying this provider cannot lose buffered local edits:
   * nothing is queued or in flight, or the block is server-confirmed gone
   * (the bytes were deliberately dropped — see `blockGone`). The owner's
   * deferred finalize checks this and, when false, RETAINS the owner (the
   * provider's reconnect listeners stay live until destroy) instead of
   * destroying bytes that a reconnect could still save.
   */
  get readyForTeardown(): boolean {
    return (
      this.destroyed ||
      this.blockGone ||
      (this.pendingUpdates.length === 0 && !this.flushInFlight)
    );
  }

  /**
   * Register the (single) owner callback invoked whenever the provider BECOMES
   * ready-for-teardown — the push-based finalize signal for a deferred finalize
   * that found buffered edits. Overwrites any previous listener (one
   * `BlockDocOwner` per provider); pass `null` to clear.
   */
  setTeardownReadyListener(cb: (() => void) | null): void {
    this.teardownReadyListener = cb;
  }

  private notifyTeardownReady(): void {
    if (this.readyForTeardown) this.teardownReadyListener?.();
  }

  /** Full teardown (owner-driven): flush, detach doc listener, kill awareness. */
  destroy(): void {
    if (this.destroyed) return;
    this.disconnect();
    this.destroyed = true;
    this.unsubscribeWsStatus();
    window.removeEventListener("online", this.onBrowserOnline);
    this.doc.off("update", this.onDocUpdate);
    this._awareness.destroy();
    this.teardownReadyListener = null;
    this.syncListeners.clear();
    this.statusListeners.clear();
    this.updateListeners.clear();
    this.reloadListeners.clear();
    this.saveStateListeners.clear();
    this.blockGoneListeners.clear();
  }

  private emitSync(isSynced: boolean): void {
    for (const cb of [...this.syncListeners]) cb(isSynced);
  }

  private emitBlockGone(): void {
    for (const cb of [...this.blockGoneListeners]) cb();
  }

  private emitStatus(status: string): void {
    for (const cb of [...this.statusListeners]) cb({ status });
  }
}
