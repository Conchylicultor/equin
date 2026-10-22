import { Doc } from "yjs";
import type { Provider } from "@lexical/yjs";
import { yDocContent } from "@plugins/primitives/plugins/collab-doc/core";
import { xmlTextContentLength } from "../../core";
import { BindingReplica, CanonicalConnection } from "./binding-replica";
import {
  LiveStateYjsProvider,
  type CollabSaveState,
  type ContentDocTransport,
} from "./live-state-yjs-provider";
import { LocalYjsProvider } from "./local-yjs-provider";
import { projectableRunsOf, type DocSourcedRuns } from "./doc-sourced-runs";
import type { RowTruth } from "./row-truth";
import { BlockRunTracker, type BlockRunsEdit } from "./block-run-tracker";

/**
 * The block-content **owner** and the per-binding **session** that holds it —
 * the lifetime half of the content-doc seam (stage 3 of
 * `research/2026-08-03-page-block-content-session-one-owner.md`). The hooks,
 * the `data.text` projection and the offscreen doc helpers live next door in
 * `use-collab-block-doc.ts`; everything about *who owns what, for how long*
 * lives here.
 *
 * Two objects, one each for the two questions that used to be answered by
 * three overlapping lifetimes layered under React mount ordering:
 *
 * - **{@link BlockDocOwner}** — one per BLOCK id, in its transport's
 *   {@link BlockDocs} registry. It
 *   owns the canonical `Y.Doc`, the transport provider and the run tracker
 *   that turns local transactions into DATA undo entries
 *   (`block-run-tracker.ts`). Three consumers need the union across every
 *   mounted binding of the block (the run tracker, the projection observer,
 *   one transport/queue/save-state), which is exactly what "one canonical doc
 *   per block" buys — so the owner STAYS, deliberately.
 *
 * ## Undo entries are data, and this module holds no history
 *
 * The owner used to carry a per-block Yjs undo manager whose stack items the
 * app's undo stack pointed at through thunks — pointers that became a SILENT
 * no-op the moment the doc was destroyed (a deleted block's editor unmounts,
 * its owner finalizes), which is how a to-do came back from Ctrl+Z without
 * its text. That machinery is gone
 * (`research/2026-09-09-page-data-based-text-undo-entries-v2.md` §2.7).
 * What remains is the run tracker: each closed typing run is emitted as a
 * {@link BlockRunsEdit} — the block's runs before and after — and the editor
 * context records it as a self-contained entry whose replay is "make this
 * block read these runs", on whichever host holds the block at that moment
 * (`block-text-write.ts` for an open doc, `block-text-write-stored.ts` for a
 * stored one). Nothing here can no-op: an entry either replays or throws.
 * - **{@link CollabSession}** — one per (block, BINDING): one hook instance's
 *   hold on the owner plus the {@link BindingReplica} it hands
 *   `CollaborationPlugin`. It owns both lifetimes and the ONE retention policy.
 *
 * The registry is per TRANSPORT ({@link BlockDocs}, one per server the editor
 * talks to — `use-block-docs.ts`): an editor inside a scope (the demo's
 * browser server) holds its blocks' docs beside that server's, so the same
 * block id open under two transports is two owners, each seeding, flushing and
 * resuming against its own host.
 *
 * ## One lifetime, one retention policy
 *
 * There used to be THREE independent deferred destroys — the registry entry's
 * (`releaseCollabDoc`'s single `destroyTimer` slot), the hook hold's replica
 * destroy, and `resetReplica`'s — each with a real reason, none aware of the
 * others. A `rehydrate()` racing an unmount could therefore destroy a replica
 * whose binding was still mounted, relaying that binding's last edits nowhere.
 * All three collapse into {@link CollabSession.end}, and every reason survives:
 *
 * - **StrictMode double-mount** (and any remount-in-place): the end is deferred
 *   ONE macrotask, because strict mode releases and re-acquires synchronously
 *   within one commit and `CollaborationPlugin` does NOT re-call its
 *   `providerFactory` on the simulated remount (verified in `@lexical/react`
 *   0.44: `isProviderInitialized` / `isBindingInitialized` refs) — it keeps the
 *   very replica and provider it already holds. {@link CollabSession.retain}
 *   cancels the pending end, so the session, the replica AND the owner all
 *   survive, in one act instead of three.
 * - **A binding still holds the replica**: when the retention window expires
 *   the session refuses to destroy a CONNECTED replica and finishes push-based
 *   on the binding's own `disconnect()` instead
 *   ({@link BindingReplica.setDisconnectListener}) — never on a second timer.
 *   This is what makes "a `restart()` racing its own remount destroys a live
 *   binding's replica" unrepresentable rather than unlikely.
 * - **Buffered bytes** (teardown retention): the owner is finalized only when
 *   `provider.readyForTeardown`; otherwise it is RETAINED and the provider's
 *   still-subscribed reconnect listeners drain the queue, then signal back
 *   through `setTeardownReadyListener`. An unmount coinciding with a transient
 *   outage must not drop the user's last edits.
 *
 * Teardown order inside one session end is explicit and load-bearing: replica
 * first (its `disconnect()` releases the refcounted transport connection, whose
 * eager flush queues the last bytes), owner second (so `readyForTeardown` is
 * evaluated against a queue that flush already filled).
 *
 * One reason is deliberately RETIRED: the old hold reconciled "my replica is
 * tagged with a DIFFERENT entry than the one I just re-acquired" and discarded
 * it. A session holds ONE owner reference for its whole life and mints its
 * replica against that owner, so a replica relaying into a dead doc is not a
 * state that can be constructed.
 *
 * ## Release by identity, never by id
 *
 * `releaseCollabDoc(blockId)` decremented whichever entry happened to sit at
 * that id. If the entry were ever replaced between a hold's acquire and its
 * release, the release decremented the WRONG one — leaking the dead entry and
 * prematurely destroying the live one (only `finalizeEntry`'s `refs > 0` bail
 * kept it from firing). A session holds the owner REFERENCE and releases that,
 * so the class is closed by construction: there is no id-keyed release left to
 * get wrong.
 *
 * ## Recovery is a new session, not a three-way coordination
 *
 * {@link CollabSession.restart} is the one recovery verb: end this session,
 * start its successor over the same owner. The successor mints a fresh EMPTY
 * replica by construction (the "binding is behind its doc" half — a binding
 * hydrates EXCLUSIVELY from post-attach events, see `binding-replica.ts`) and
 * the owner re-reads the authoritative server state (the "doc is behind the
 * server" half). The caller's only remaining job is bumping the
 * `CollaborationPlugin` key, because Lexical builds its binding exactly once
 * per mount behind a ref — a changed key is the ONLY thing that re-attaches a
 * binding.
 *
 * ## The hydration state (stage 4)
 *
 * A session's whole reason to exist is one property:
 *
 * > What this binding RENDERS equals what this session's replica HOLDS.
 *
 * {@link SessionState} makes that explicit and, in the one case that matters,
 * PROVEN. It is monotonic — `attaching → hydrating → hydrated | stalled` — and
 * per session: recovery is a NEW session ({@link CollabSession.restart}), never
 * a state that walks backwards. So a later re-assert (the
 * `markBlockRowConfirmed`-triggered doc-init of a client-minted block, a second
 * server push, a StrictMode re-`connect()`) can never re-open a gate a proof
 * already closed.
 *
 * Two arms, chosen at {@link CollabSession.start}:
 *
 * - **Locally authoritative** (`rowTruth === "unseen"` — a block this client
 *   has never seen in server truth, see `row-truth.ts` — and the whole
 *   in-memory transport). The content is this client's own deterministic seed,
 *   applied into the replica at `connect()` AFTER the binding attached — there
 *   is no remote answer that could be missing, so there is nothing to prove and
 *   nothing to wait for: `attaching → hydrated` inside one synchronous
 *   `connect()`, no network. This is what keeps the instant-split path instant
 *   (`maybeInit()` returns immediately while the row is unconfirmed, so
 *   anything waiting on the server here would cost a freshly-split block a full
 *   round trip), and it makes `stalled` structurally unreachable in memory mode.
 * - **Server authoritative** (`"present"` — an existing block, confirmed at
 *   its very first render — or `"removed"` — a row this client once saw in
 *   server truth and re-created optimistically, whose stored doc SURVIVES the
 *   delete because every delete is a trash). The replica is EMPTY by
 *   construction at attach, so agreement is only interesting once the server's
 *   answer is in:
 *   - replica holds content at `connect()` (a held warm-nav push, a second
 *     editor joining, a restart over a populated owner) ⇒ `hydrating` until the
 *     first `COLLABORATION_TAG` commit proves it;
 *   - replica empty and the transport not yet synced ⇒ `hydrating`; the answer
 *     is still coming, and the exit is push-based on the transport's own `sync`
 *     announcement, never a timer;
 *   - replica empty and the transport SYNCED ⇒ `hydrated`. The server's answer
 *     carries nothing for the binding to render, and Yjs emits no event for an
 *     apply that integrates nothing — so NO commit will ever come, and waiting
 *     for one would strand every genuinely-empty block in `hydrating` forever.
 *
 * **The verification is NOT synchronous, and that is a property of the
 * libraries rather than a choice.** `syncYjsChangesToLexical` (`@lexical/yjs`
 * 0.44) calls `editor.update(...)` with NO `discrete`, and
 * `$commitPendingUpdates` is micro-tasked (`lexical` 0.44), while yjs emits
 * `doc.on('update')` at the tail of the same `applyUpdate`. Inside any of our
 * own handlers the editor is therefore exactly ONE microtask stale — a
 * same-turn equality check would report a blind binding on EVERY keystroke.
 * Hence {@link CollabSession.verifyRendered}, driven off the first tagged
 * commit: the direct causal successor of the apply, bounded, not a timer. Do
 * NOT reach for `editor.read()` to force synchrony — from a Yjs update handler
 * it re-enters `syncLexicalUpdateToYjs`, opening a transaction on the replica
 * from inside that doc's own transaction cleanup.
 *
 * The two lengths are the stage-0 counters and nothing else:
 * `$xmlBasisContentLength()` (editor side) against `xmlTextContentLength()`
 * (doc side), pinned to each other by a property test over the shared fuzz
 * corpus. They are AGREEMENT WITNESSES, not character counts (a
 * `CollabTextNode` is two delta ops, so `"hello"` counts 6). Measured against
 * this session's own REPLICA, never the canonical: the honest question is "did
 * MY binding ingest what MY replica holds", and the canonical would import
 * another binding's concurrency into this session's verdict for no benefit.
 *
 * ## What the state GATES — the write path, never the editing host
 *
 * `hydrating` means **the projection does not write and the transport does not
 * flush**. It does NOT mean the block stops being an editing host: the
 * intuitive `contentEditable={false}` form DEADLOCKS the caret authority (a
 * non-focusable root makes the landing policy's `root.focus()` a silent no-op,
 * while `reconcile()` only counts commits where the target is NOT rendered —
 * and it IS rendered — so `FLIGHT_MISS_LIMIT` never trips, the flight never
 * ends, and the keyboard is held). The replica is empty BY CONSTRUCTION at
 * attach, so a keystroke into a not-yet-hydrated replica is a legitimate
 * concurrent edit that merges; it is never a wrong baseline.
 *
 * The gate is OPEN in `attaching` (nothing delivered, so nothing to be behind),
 * `hydrated` (proven) and `stalled` (failed — a failure must not hold the
 * user's bytes hostage; it gets a visible Retry instead), and it is released
 * unconditionally the moment the session is told to END, so an unmount always
 * flushes.
 *
 * ## What the user WAS SHOWN — {@link BlockDocOwner.everRendered}
 *
 * The hydration state is per session and about AGREEMENT NOW. A second,
 * strictly weaker fact matters to whoever paints a placeholder: has this
 * block's text ever actually been on screen? A skeleton is honest over a line
 * that never showed anything, and a lie over one the user was reading a moment
 * ago — so it must never paint there, no matter what the current session can
 * prove.
 *
 * That fact is MONOTONIC and lives on the OWNER, deliberately, because both
 * things that reset a session are exactly what it has to survive:
 *
 * - recovery mints a NEW session ({@link CollabSession.restart}), whose state
 *   walks back to `attaching`;
 * - moving a block into or out of a container frame remounts its Lexical
 *   instance, so a component-level ref would be reset by a DOM reparent.
 *
 * It is set from {@link CollabSession.verifyRendered} — every commit that
 * reports a non-zero rendered length, including the `promoteOnly` probe and the
 * commits that arrive after the state is settled — and it is NEVER cleared. It
 * is not an agreement claim and must not be read as one: "was shown" says
 * nothing about whether what is shown is still current, which is why it gates
 * only the skeleton and nothing on the write path.
 */

/** Why a session could not prove its binding renders what its replica holds. */
export type StallReason =
  /**
   * The first `COLLABORATION_TAG` commit after the authoritative apply rendered
   * LESS (or more) than the replica holds — the binding ingested only part of
   * what it was given. A fully blind binding produces no commit at all and
   * stays `hydrating` (with the write path gated, which is the safe outcome);
   * this is the partial case, and it is a real defect worth a Retry.
   */
  "binding-behind-replica";

/**
 * Where a (block, binding) session is between "the replica exists" and "what
 * the user sees provably equals what that replica holds". Monotonic; read the
 * module comment for the two arms and for what each state gates.
 */
export type SessionState =
  /** Replica minted EMPTY, binding mounting. Nothing delivered yet. */
  | { readonly kind: "attaching" }
  /** Authoritative state applying — requested, arriving, or not yet proven on screen. */
  | { readonly kind: "hydrating" }
  /** VERIFIED: what the binding renders agrees with what its replica holds. */
  | { readonly kind: "hydrated"; readonly at: number }
  /** Verification failed. `shownLength`/`docLength` are same-basis witnesses. */
  | {
      readonly kind: "stalled";
      readonly reason: StallReason;
      readonly shownLength: number;
      readonly docLength: number;
    };

/**
 * The state every session starts in, as a shared frozen constant: a consumer
 * reading the hydration state before its first session exists (a render before
 * any effect ran) needs a stable `getSnapshot()` identity or
 * `useSyncExternalStore` loops.
 */
export const ATTACHING_STATE: SessionState = Object.freeze({
  kind: "attaching" as const,
});

/**
 * The provider contract the owner + the two doc hooks depend on: the
 * `@lexical/yjs` {@link Provider} surface plus the seam-specific lifecycle
 * (`destroy`, teardown-readiness) and the server-sync entry points
 * (`markBlockRowConfirmed`, `onServerState`) and the derived save state the
 * consumer reports to the sync-status cloud (`onSaveState`/`getSaveState`/
 * `retryFlush`). Two implementations — {@link LiveStateYjsProvider}
 * (server-synced) and {@link LocalYjsProvider} (in-memory, no network) —
 * satisfy it, so the owner is transport-agnostic. The local provider's
 * server-sync methods are deliberate no-ops and its save state is permanently
 * idle: with no transport there is never anything outstanding to save.
 */
export interface BlockDocProvider extends Provider {
  markBlockRowConfirmed(): void;
  onServerState(state: string | null): void;
  /**
   * Re-read the server's authoritative state into the doc (the READ-side
   * counterpart to `retryFlush`). Driven by {@link CollabSession.restart} —
   * a new session over an existing owner re-reads by construction.
   */
  rehydrateFromServer(): void;
  /** Has any local edit ever entered this doc? (starvation discriminator) */
  readonly hasLocalEdits: boolean;
  /**
   * Could a stored doc exist behind this block on the server? False only when
   * this client has never seen the block id in server truth (`"unseen"`, see
   * `row-truth.ts`) — nothing can have been stored for a block the server has
   * never acknowledged — and permanently false on the local transport, which
   * stores nothing. The pre-seed discriminator, and half of
   * {@link BlockDocOwner.docAuthoritative}.
   */
  readonly mayHaveStoredDoc: boolean;
  /**
   * Has the transport's authoritative answer landed? The push-based exit from
   * `hydrating` for a block the server holds nothing renderable for — paired
   * with the provider's own `sync` event, which announces the transition (see
   * the module comment's server-authoritative arm). Permanently true on the
   * local transport: with no server there is never an answer to wait for.
   */
  readonly isSynced: boolean;
  /**
   * Has the transport learned, from the server, that the block no longer
   * exists (doc-init 404 — purged, since a delete is a trash and keeps the row
   * addressable)? TERMINAL: the doc will never sync and never flush, so a
   * replay waiting on this owner's `sync` must stop waiting. Permanently false
   * on the local transport, which has no server to lose a block to.
   */
  readonly isBlockGone: boolean;
  /**
   * Subscribe to the `isBlockGone` flip (fires at most once per provider).
   * Returns the unsubscribe. The push-based exit `ownerSynced` takes beside
   * the `sync` event and the owner's finalization — every wait a replay can
   * enter has a terminal answer.
   */
  onBlockGone(cb: () => void): () => void;
  /**
   * Hold the transport's OUTBOUND flush while some session's hydration is
   * unproven (see the module comment). Refcounted, because one block's owner is
   * shared by every mounted binding of it. Releasing the last hold resumes a
   * queue that was left waiting — push-based, never a timer. A held queue is
   * only ever DEFERRED, never dropped: the bytes stay in `pendingUpdates`, the
   * save state stays `syncing`, and a session releases its hold the moment it
   * is told to end, so an unmount always flushes.
   */
  acquireFlushHold(): void;
  releaseFlushHold(): void;
  onSaveState(cb: () => void): () => void;
  getSaveState(): CollabSaveState;
  retryFlush(): void;
  get readyForTeardown(): boolean;
  setTeardownReadyListener(cb: (() => void) | null): void;
  destroy(): void;
}

/**
 * One transport's block → owner map, and the transport its server-synced docs
 * seed and flush over. The map is private: the only id-keyed reads are
 * {@link CollabSession.start} (which acquires) and {@link blockDocOwnerOf}
 * (for the editor context's mutation chokepoints, which know a block id and
 * nothing else). Nothing releases by id — see the module comment. Editors get
 * their transport's through `useBlockDocs()` (`use-block-docs.ts`).
 */
export class BlockDocs {
  /** Where this registry's server-synced docs seed, flush and resume. */
  readonly server: ContentDocTransport;
  private readonly owners = new Map<string, BlockDocOwner>();

  constructor(server: ContentDocTransport) {
    this.server = server;
  }

  /** The owner of `blockId`, minting it on the first ask. */
  acquire(
    blockId: string,
    buildSeedState: () => Uint8Array,
    rowTruth: RowTruth,
    serverSync: boolean,
  ): BlockDocOwner {
    let owner = this.owners.get(blockId);
    if (!owner) {
      owner = new BlockDocOwner(
        blockId,
        buildSeedState,
        rowTruth,
        serverSync ? this.server : null,
        this.owners,
      );
      this.owners.set(blockId, owner);
    }
    return owner;
  }

  /** The live owner of `blockId`, or `null` (see {@link blockDocOwnerOf}). */
  ownerOf(blockId: string): BlockDocOwner | null {
    return this.owners.get(blockId) ?? null;
  }

  /** Every live owner of this registry. */
  liveOwners(): Iterable<BlockDocOwner> {
    return this.owners.values();
  }
}

/**
 * A block's content owner: ONE canonical `Y.Doc` + transport provider + run
 * tracker per block id, shared by every mounted binding of that block (two
 * docs for one block would fork the CRDT).
 *
 * Its mutable state — the session refcount — is `private`, so no consumer can
 * reach for it. The run tracker's suppression is the SCOPE of
 * {@link untracked} rather than a public field a listener registered
 * somewhere else reads: entering the scope is the suppression, and the scope
 * is the only thing that can raise it.
 *
 * ## The run tracker (the data entries' recorder)
 *
 * Every local transaction on the canonical doc — typing, surgery, anything
 * relayed from a binding — is folded by {@link BlockRunTracker} into runs
 * closed by a 500 ms idle window, each emitted as a {@link BlockRunsEdit}
 * (`before`/`after` runs, read through {@link runsNow}) to {@link onRunsEdit}
 * subscribers. Origins are classified by the STATED three-origin rule (the
 * provider, `TEXT_REPLAY_ORIGIN`, the relayed binding — see the tracker's
 * module comment), never learned. {@link untracked} is the suppression scope
 * for callers recording their own entry around a surgery; {@link closeTextRun}
 * and {@link closeAllOpenTextRuns} seal open runs before an undo pops.
 */
export class BlockDocOwner {
  readonly blockId: string;
  readonly doc: Doc;
  readonly provider: BlockDocProvider;
  /**
   * Refcounted connect/disconnect delegation shared by every replica over this
   * owner: the transport connects with the first connected replica and
   * disconnects (eager flush) with the last (see `binding-replica.ts`).
   */
  readonly replicaConnection: CanonicalConnection;
  /** The data-entry recorder over this doc (see the class doc). */
  private readonly tracker: BlockRunTracker;
  /**
   * Does this block's content sync with a server at all? Read by
   * {@link CollabSession.restart} to pick the successor's hydration arm: a
   * re-read is server-authoritative when there IS a server, and permanently
   * locally-authoritative when there is not.
   */
  readonly serverSync: boolean;

  /**
   * Content generation: bumped on every integrating canonical-doc transaction
   * (`doc.on("update")` fires once per transaction that changed something, for
   * local AND server-applied changes alike). The memo key of {@link runsNow}.
   */
  private gen = 0;
  /** What {@link runsNow} last read, and at which generation. */
  private runsMemo: {
    readonly gen: number;
    readonly runs: DocSourcedRuns;
  } | null = null;

  /** How many {@link CollabSession}s hold this owner. Never touched by id. */
  private sessions = 0;
  /** Monotonic "this block's text has been on screen" — see the module comment. */
  private rendered = false;
  private readonly renderedListeners = new Set<() => void>();
  /** Fired once, from {@link finalize}, when this owner's doc is destroyed. */
  private readonly destroyedListeners = new Set<() => void>();
  /** The registry ({@link BlockDocs}) this owner is the entry of. */
  private readonly registry: Map<string, BlockDocOwner>;

  /** Minted by {@link BlockDocs.acquire} only, into `registry`. */
  constructor(
    blockId: string,
    buildSeedState: () => Uint8Array,
    rowTruth: RowTruth,
    server: ContentDocTransport | null,
    registry: Map<string, BlockDocOwner>,
  ) {
    this.blockId = blockId;
    this.registry = registry;
    this.serverSync = server !== null;
    this.doc = new Doc();
    // Transport seam: a server-synced editor gets the live-state provider
    // (the `blockDocs` row in, doc-init/doc-update out); the in-memory editor
    // (`persist={false}`) gets a purely local provider that seeds from
    // `data.text` and never networks. `rowTruth` is the consumer's RENDER-TIME
    // view (see useCollabBlockDoc and `row-truth.ts`) — construction-accurate,
    // so the server provider's pre-seed discriminator never depends on the
    // later `markBlockRowConfirmed` parent effect having run (irrelevant for
    // local, which ignores it). `server` is the minting editor's transport:
    // the doc seeds and flushes to the host that editor is served by.
    this.provider =
      server !== null
        ? new LiveStateYjsProvider(
            this.doc,
            blockId,
            buildSeedState,
            rowTruth,
            server,
          )
        : new LocalYjsProvider(this.doc, buildSeedState, rowTruth);
    this.replicaConnection = new CanonicalConnection(this.provider);
    // The content generation behind `runsNow()`'s memo. `update` fires only for
    // a transaction that integrated something, so a redundant re-apply of state
    // the doc already holds keeps the memo valid.
    this.doc.on("update", () => {
      this.gen += 1;
    });
    // The run tracker subscribes AFTER the generation bump above, so a run
    // boundary it closes from an `update` reads a fresh `runsNow()`.
    this.tracker = new BlockRunTracker({
      blockId,
      doc: this.doc,
      providerOrigin: this.provider,
      runsNow: () => this.runsNow(),
    });
  }

  /** Is this still the registry's live owner for its block? */
  get isLive(): boolean {
    return this.registry.get(this.blockId) === this;
  }

  /**
   * The canonical doc's content as runs, RIGHT NOW — memoized on the content
   * generation, so every reader landing on the same generation (the projection
   * flush, a structural entry pinning a deleted row's text, a run boundary)
   * shares one headless read instead of each performing its own.
   *
   * The brand is preserved by construction: the memo stores exactly what
   * {@link projectableRunsOf} — the sole `DocSourcedRuns` producer — produced,
   * so a value read through here is still provably read from the doc.
   */
  runsNow(): DocSourcedRuns {
    const memo = this.runsMemo;
    if (memo && memo.gen === this.gen) return memo.runs;
    const runs = projectableRunsOf(this.doc);
    this.runsMemo = { gen: this.gen, runs };
    return runs;
  }

  /**
   * Is what this doc holds the AUTHORITY for the block's text right now? True
   * once the transport's authoritative answer landed, and for a doc that can
   * have nothing stored behind it (a client-minted block's pre-applied seed,
   * the whole in-memory transport). False for an existing or restored block
   * whose subscription has not answered yet: its doc is empty because nothing
   * ARRIVED, and reading that emptiness as "the text is empty" would turn a
   * not-known-yet into a claim about the user's data.
   */
  get docAuthoritative(): boolean {
    return this.provider.isSynced || !this.provider.mayHaveStoredDoc;
  }

  // --- "Was shown" (see the module comment) ----------------------------------

  /**
   * Has ANY binding of this block ever rendered a non-empty line? Monotonic and
   * never cleared: it states what the user WAS SHOWN, not what any session can
   * currently prove. Read only by the placeholder — it is not an agreement
   * witness and gates nothing on the write path.
   */
  get everRendered(): boolean {
    return this.rendered;
  }

  /**
   * Latch {@link everRendered}. Called from
   * {@link CollabSession.verifyRendered} for every commit reporting a non-zero
   * rendered length. Notifies only on the false→true flip — the monotonic edge
   * is the only transition there is.
   */
  noteRendered(): void {
    if (this.rendered) return;
    this.rendered = true;
    for (const cb of [...this.renderedListeners]) cb();
  }

  /**
   * Subscribe to that one flip. Every session over this owner registers one, so
   * a second mounted binding's first commit re-renders THIS binding's
   * placeholder too — the fact is the block's, not the binding's.
   */
  onEverRendered(cb: () => void): () => void {
    this.renderedListeners.add(cb);
    return () => {
      this.renderedListeners.delete(cb);
    };
  }

  // --- The run tracker (see the class doc and `block-run-tracker.ts`) --------

  /**
   * Subscribe to every closed, non-empty local editing run as DATA: the
   * block's runs before and after it. THE channel a text undo entry is
   * recorded from.
   */
  onRunsEdit(cb: (edit: BlockRunsEdit) => void): () => void {
    return this.tracker.onRunsEdit(cb);
  }

  /**
   * Seal the open typing run, if any, emitting it to {@link onRunsEdit}. The
   * pending flush an undo runs first, so a ⌘Z mid-run undoes that run.
   */
  closeTextRun(): void {
    this.tracker.closeRun();
  }

  /**
   * Run `edit` with the tracker ignoring every local transaction it lands (see
   * `block-run-tracker.ts`): for a caller recording its OWN data entry around
   * a binding-origin surgery. Closes any open run first. The transaction must
   * land synchronously inside the scope (`discrete: true`).
   */
  untracked<T>(edit: () => T): T {
    return this.tracker.untracked(edit);
  }

  /**
   * Subscribe to this owner's finalization (its doc is destroyed). A replay
   * waiting on this owner's transport resolves the block again instead of
   * hanging on a doc nothing will hydrate.
   */
  onDestroyed(cb: () => void): () => void {
    this.destroyedListeners.add(cb);
    return () => {
      this.destroyedListeners.delete(cb);
    };
  }

  // --- Lifetime (session-driven; see CollabSession) --------------------------

  /** Take one session's hold. Registry/session-internal. */
  addSession(): void {
    this.sessions += 1;
  }

  /**
   * Drop one session's hold and finalize if that was the last. Called ONLY
   * with the owner reference the session has held all along — never resolved
   * from a block id (see the module comment).
   */
  removeSession(): void {
    if (this.sessions <= 0) {
      // More releases than holds: a session lifetime bug upstream. Loud rather
      // than a silently negative refcount that would keep a dead owner alive.
      throw new Error(
        `BlockDocOwner("${this.blockId}"): removeSession() without a matching addSession()`,
      );
    }
    this.sessions -= 1;
    if (this.sessions === 0) this.finalize();
  }

  /**
   * Destroy this owner if it is still the registry's live owner, unheld, AND
   * its provider has nothing buffered that a reconnect could still save.
   * Otherwise it is RETAINED (teardown-flush safety): an ordinary unmount
   * coinciding with a transient outage leaves the eager disconnect flush
   * re-queued — destroying then would drop the user's last edits even though
   * the tab lives and will reconnect. The provider's ws-reopen/`online`
   * listeners stay subscribed until destroy, so the retained queue drains
   * push-based; the provider then invokes this again via its (single-slot)
   * teardown-ready listener. Truly destroyed once flushed or the block is
   * server-confirmed gone — never on a timer, never by dropping bytes.
   */
  private finalize(): void {
    if (this.sessions > 0) return;
    if (!this.isLive) return; // already finalized / replaced
    if (!this.provider.readyForTeardown) {
      this.provider.setTeardownReadyListener(() => this.finalize());
      return;
    }
    this.registry.delete(this.blockId);
    this.tracker.dispose();
    this.provider.destroy();
    this.doc.destroy();
    for (const cb of [...this.destroyedListeners]) cb();
    this.destroyedListeners.clear();
  }
}

/**
 * Seal every block's open typing run — the page editor's pending flush
 * (`usePendingFlush`), run by the undo-redo primitive at the start of every
 * undo/redo turn so the run the user is in the middle of is the entry popped,
 * not the one below it.
 */
export function closeAllOpenTextRuns(docs: BlockDocs): void {
  for (const owner of docs.liveOwners()) owner.closeTextRun();
}

/**
 * The block's live content owner, or `null` when no editor holds one. THE only
 * id-keyed read of the registry left, for callers that legitimately know a
 * block id and nothing else: the editor context's mutation chokepoints (which
 * read `runsNow()` and run their surgery inside `untracked`) and the replay
 * host selection (`block-text-write-stored.ts`). A read at RECORD time is a
 * capture of the doc's runs, never a reference an entry holds — an entry
 * outlives any owner.
 */
export function blockDocOwnerOf(
  docs: BlockDocs,
  blockId: string,
): BlockDocOwner | null {
  return docs.ownerOf(blockId);
}

/**
 * ONE session per (block, binding): a hook instance's hold on the block's
 * {@link BlockDocOwner} plus the {@link BindingReplica} its
 * `CollaborationPlugin` binds to. Owns both lifetimes and the single retention
 * policy — read the module comment before changing any of it.
 */
export class CollabSession {
  /** The block's canonical owner, held BY REFERENCE for this session's life. */
  readonly owner: BlockDocOwner;

  /**
   * Is this session's authoritative content its OWN deterministic seed rather
   * than the server's answer? True for a client-minted block (`rowTruth ===
   * "unseen"` — this client has never seen the id in server truth, so nothing
   * can have been stored for it) and for the whole in-memory transport. NOT
   * true for a re-created row (`"removed"`): the server soft-deletes every
   * block, so its stored doc survives the delete and is the authority. See the
   * module comment's two arms; it is what keeps the instant-split path instant
   * and `stalled` unreachable in memory mode.
   */
  readonly locallyAuthoritative: boolean;

  private replica: BindingReplica | null = null;
  /** The ONE retention timer (see the module comment). */
  private retention: ReturnType<typeof setTimeout> | null = null;
  /** Ending, but waiting on a still-connected replica's binding to let go. */
  private awaitingDisconnect = false;
  private ended = false;
  /**
   * Told to end (scheduled, or already finished). Distinct from {@link ended}
   * because the WRITE GATE must open the instant teardown is decided, not when
   * it completes: the final projection flush and the transport's eager
   * disconnect flush both run inside the retention window.
   */
  private ending = false;

  private hydration: SessionState = ATTACHING_STATE;
  private readonly stateListeners = new Set<() => void>();
  /** Does this session currently hold the owner transport's flush? */
  private flushHeld = false;
  /** Unsubscribe from the transport's `sync` announcement while hydrating. */
  private syncUnsubscribe: (() => void) | null = null;
  /** Unsubscribe from the owner's `everRendered` flip. */
  private renderedUnsubscribe: (() => void) | null = null;

  private constructor(owner: BlockDocOwner, locallyAuthoritative: boolean) {
    this.owner = owner;
    this.locallyAuthoritative = locallyAuthoritative;
    owner.addSession();
    // `everRendered` is one of the two facts a consumer reads off this session
    // (see {@link everRendered}), so its flip travels the SAME listener channel
    // as a state transition — one subscription for the consumer, one snapshot.
    this.renderedUnsubscribe = owner.onEverRendered(() => this.notifyState());
  }

  /**
   * Start a session over `blockId`, creating the block's owner on the first
   * one. Every start must be paired with exactly one {@link end}.
   *
   * `rowTruth` is the consumer's RENDER-TIME view of the block id in server
   * truth (`row-truth.ts`), and it picks this session's hydration arm as well
   * as (on the first session) the provider's pre-seed discriminator — an
   * existing block is `"present"` from its very first render, a client-minted
   * one `"unseen"`, a re-created one `"removed"`.
   *
   * `docs` is the editor's transport's registry (`useBlockDocs()`); a minted
   * owner syncs with its server when `serverSync`, and is purely local (the
   * in-memory editor, whose docs never network) otherwise. Both are read only
   * when this start mints the owner.
   */
  static start(
    docs: BlockDocs,
    blockId: string,
    buildSeedState: () => Uint8Array,
    rowTruth: RowTruth,
    serverSync: boolean,
  ): CollabSession {
    const owner = docs.acquire(blockId, buildSeedState, rowTruth, serverSync);
    return new CollabSession(owner, !serverSync || rowTruth === "unseen");
  }

  get blockId(): string {
    return this.owner.blockId;
  }

  /** Has this session finished tearing down? (a spent session is never reused) */
  get isEnded(): boolean {
    return this.ended;
  }

  // --- Hydration state (see the module comment) ------------------------------

  /** Where this session is between "replica exists" and "proven on screen". */
  get state(): SessionState {
    return this.hydration;
  }

  /**
   * Has this block's text ever been on screen? The owner's monotonic latch —
   * so it survives THIS session (recovery mints a new one) and any remount.
   * See the module comment; it gates the skeleton and nothing else.
   */
  get everRendered(): boolean {
    return this.owner.everRendered;
  }

  /**
   * May the write path run? Closed exactly while `hydrating` — the projection
   * must not persist, and the transport must not flush, a value this session
   * cannot yet prove the user is looking at. Open the moment teardown is
   * decided, so the final flush is never swallowed.
   */
  get writeAllowed(): boolean {
    return this.ending || this.hydration.kind !== "hydrating";
  }

  /** Subscribe to hydration-state transitions (a `useSyncExternalStore` pair). */
  subscribeState(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /**
   * The replica's content length, in the Yjs basis — the doc-side half of the
   * agreement witness (see the module comment). Zero before a replica exists:
   * a session with no binding renders nothing and holds nothing.
   */
  private replicaContentLength(): number {
    const replica = this.replica;
    if (!replica || replica.isDestroyed) return 0;
    return xmlTextContentLength(yDocContent(replica.replicaDoc));
  }

  private setState(next: SessionState): void {
    this.hydration = next;
    if (next.kind !== "hydrating") {
      this.syncUnsubscribe?.();
      this.syncUnsubscribe = null;
    }
    this.syncFlushHold();
    this.notifyState();
  }

  /** Publish "something a consumer reads off this session moved" (see the ctor). */
  private notifyState(): void {
    for (const cb of [...this.stateListeners]) cb();
  }

  /** Take/drop the owner transport's flush hold to match the current state. */
  private syncFlushHold(): void {
    const want = !this.writeAllowed && !this.ended;
    if (want === this.flushHeld) return;
    this.flushHeld = want;
    if (want) this.owner.provider.acquireFlushHold();
    else this.owner.provider.releaseFlushHold();
  }

  /**
   * The replica finished a `connect()`: relay attached, transport delegated,
   * catch-up state applied. THE point at which this session learns what its
   * binding was handed — see the module comment for the arms. Monotonic, so
   * every later connect (a StrictMode disconnect→connect, whose catch-up
   * re-apply integrates nothing and would therefore produce no commit) is a
   * no-op rather than a second, unresolvable obligation.
   */
  noteCatchUp(): void {
    if (this.ended || this.hydration.kind !== "attaching") return;
    if (this.locallyAuthoritative) {
      // This client IS the authority: the deterministic seed went into the
      // replica through an already-attached relay, so there is no remote answer
      // that could be missing and nothing to prove. No network, no wait.
      this.setState({ kind: "hydrated", at: Date.now() });
      return;
    }
    this.setState({ kind: "hydrating" });
    // Push-based exit for "the answer carries nothing renderable": the
    // transport announces its own sync, and re-announces on reconnect.
    const onSync = (): void => this.settleHydration();
    this.owner.provider.on("sync", onSync);
    this.syncUnsubscribe = () => this.owner.provider.off("sync", onSync);
    this.settleHydration();
  }

  /**
   * Resolve `hydrating` for a replica the server had nothing renderable for.
   * Content in the replica means a commit is coming and will prove it; an empty
   * replica plus an UNSYNCED transport means the answer is still on its way.
   * Only the third case — synced, and still nothing to render — is trivially
   * hydrated, and it must be, or every genuinely-empty block waits forever for
   * a commit Yjs will never schedule.
   */
  private settleHydration(): void {
    if (this.ended || this.hydration.kind !== "hydrating") return;
    if (this.replicaContentLength() > 0) return;
    if (!this.owner.provider.isSynced) return;
    this.setState({ kind: "hydrated", at: Date.now() });
  }

  /**
   * A `COLLABORATION_TAG` commit landed: `shownLength` is what the binding
   * renders, in the same Yjs basis the replica is measured in. The direct
   * causal successor of the authoritative apply — read the module comment for
   * why this cannot be checked synchronously.
   *
   * `promoteOnly` is for the one caller that may be LATE (the consumer's
   * listener registering after a commit already fired): it may confirm
   * agreement but must never conclude disagreement, because a pending commit
   * legitimately looks like a mismatch.
   */
  verifyRendered(shownLength: number, promoteOnly = false): void {
    // FIRST, and outside every guard below: a commit that rendered something is
    // the user having SEEN something, whatever this session goes on to conclude
    // about agreement — including the late `promoteOnly` probe, a commit
    // arriving after the state settled, and a session already spent. Monotonic,
    // owner-scoped, never cleared (see the module comment).
    if (shownLength > 0) this.owner.noteRendered();
    if (this.ended || this.hydration.kind !== "hydrating") return;
    const docLength = this.replicaContentLength();
    if (shownLength === docLength) {
      this.setState({ kind: "hydrated", at: Date.now() });
      return;
    }
    if (promoteOnly) return;
    this.setState({
      kind: "stalled",
      reason: "binding-behind-replica",
      shownLength,
      docLength,
    });
  }

  /**
   * This session's binding replica, minted lazily on the `providerFactory`
   * call — a fresh, EMPTY `Y.Doc` the binding attaches to and hydrates from
   * post-attach events only (`binding-replica.ts`). One per session, valid
   * only against {@link owner}'s canonical doc, which is why it can never
   * outlive the session that holds that owner.
   */
  replicaForBinding(): BindingReplica {
    if (this.ended) {
      throw new Error(
        `CollabSession("${this.blockId}"): replicaForBinding() after the session ended`,
      );
    }
    this.replica ??= new BindingReplica(
      this.owner.doc,
      this.owner.provider,
      this.owner.replicaConnection,
      // The replica's connect() is where this session learns what its binding
      // was handed — see {@link noteCatchUp}.
      () => this.noteCatchUp(),
    );
    return this.replica;
  }

  /**
   * Cancel a scheduled (or disconnect-pending) end — the remount-in-place
   * path, where `CollaborationPlugin` keeps the very replica and provider it
   * already holds. The session, its replica and its owner all survive.
   */
  retain(): void {
    if (this.ended) {
      throw new Error(
        `CollabSession("${this.blockId}"): retain() after the session ended`,
      );
    }
    if (this.retention !== null) {
      clearTimeout(this.retention);
      this.retention = null;
    }
    if (this.awaitingDisconnect) {
      this.awaitingDisconnect = false;
      this.replica?.setDisconnectListener(null);
    }
    // The write gate opened when the end was decided; this session lives on, so
    // an unproven hydration closes it again.
    this.ending = false;
    this.syncFlushHold();
  }

  /**
   * Schedule THE end of this session: destroy its replica, release its hold on
   * the owner. Deferred one macrotask (StrictMode) and then, if a binding
   * still holds the replica, deferred again onto that binding's own
   * `disconnect()` — never onto a second timer. Idempotent.
   */
  end(): void {
    if (this.ended || this.retention !== null || this.awaitingDisconnect)
      return;
    // Teardown is DECIDED here, and the write gate opens with the decision, not
    // with its completion: the consumer's final projection flush and the
    // transport's eager disconnect flush both run inside the retention window,
    // and neither may be swallowed by an unproven hydration. `retain()` closes
    // it again if the end turns out to be a remount in place.
    this.ending = true;
    this.syncFlushHold();
    this.retention = setTimeout(() => {
      this.retention = null;
      this.endNow();
    }, 0);
  }

  /**
   * End this session and return its successor over the SAME owner — the one
   * recovery verb (see the module comment). The successor takes its hold
   * BEFORE this one lets go, so the owner (and everything buffered in its
   * transport) is never transiently unheld.
   */
  restart(): CollabSession {
    if (this.ended || this.retention !== null || this.awaitingDisconnect) {
      // Recovering a session that is already tearing down would mint a
      // successor nothing will ever end — the hook that would have ended it is
      // the one that just unmounted. Loud, because it means a recovery fired
      // from a surface that is gone.
      throw new Error(
        `CollabSession("${this.blockId}"): restart() on a session that is already ending`,
      );
    }
    // A recovery re-reads the SERVER's authoritative state, so the successor
    // takes the server-authoritative arm whenever there is a server at all —
    // never the locally-authoritative one this session may have started on (its
    // row is long confirmed by now). With no server there is nothing to be
    // behind, so the local transport stays locally authoritative forever.
    const successor = new CollabSession(this.owner, !this.owner.serverSync);
    // The successor's replica is empty by construction; the owner's doc is
    // whatever it managed to receive, so the other half of recovery is the
    // authoritative re-read. Together they are what "a new session" MEANS
    // here, which is why neither is a decision the caller makes.
    this.owner.provider.rehydrateFromServer();
    this.end();
    return successor;
  }

  private endNow(): void {
    if (this.ended) return;
    const replica = this.replica;
    if (replica && replica.isConnected) {
      // A binding still holds this replica (an unmount whose
      // CollaborationPlugin cleanup has not run yet, or a restart racing its
      // own remount). Destroying now would leave that binding relaying its
      // last edits into a dead doc — silently, since `disconnect()` after
      // `destroy()` is guarded. Finish on the binding's own disconnect.
      this.awaitingDisconnect = true;
      replica.setDisconnectListener(() => {
        this.awaitingDisconnect = false;
        this.endNow();
      });
      return;
    }
    this.ended = true;
    this.replica = null;
    this.syncUnsubscribe?.();
    this.syncUnsubscribe = null;
    this.renderedUnsubscribe?.();
    this.renderedUnsubscribe = null;
    this.syncFlushHold(); // a spent session holds nothing
    this.stateListeners.clear();
    // Replica FIRST: its disconnect releases the refcounted transport
    // connection, whose eager flush queues the last local bytes — so the
    // owner's `readyForTeardown` retention check below sees them.
    replica?.setDisconnectListener(null);
    replica?.destroy();
    this.owner.removeSession();
  }
}
