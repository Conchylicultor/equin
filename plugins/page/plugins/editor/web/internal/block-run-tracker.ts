import type { Doc, Transaction } from "yjs";
import { runsEqual, runsLength, type RichText } from "../../core";
import { TEXT_REPLAY_ORIGIN } from "./block-text-write";
import { undoConflictReportSink } from "./undo-conflict-report";

/**
 * The per-block **run tracker**: turns the stream of local transactions on a
 * block's canonical `Y.Doc` into DATA undo entries — one {@link BlockRunsEdit}
 * per typing run, carrying the block's runs before and after the run — instead
 * of pointers into a per-block Yjs undo manager's stack, which the deleted
 * pointer model relied on
 * (`research/2026-09-09-page-data-based-text-undo-entries-v2.md` §2.3). It is
 * owned by the block's `BlockDocOwner` (`collab-session.ts`), which hands it the
 * memoized doc read (`runsNow`) and its transport provider; it is a leaf on its
 * own so the bun suite can drive it on a bare `Y.Doc`.
 *
 * ## The three origins
 *
 * Exactly three transaction origins reach a canonical doc, and the tracker's
 * whole classification is stated over them — never learned:
 *
 * - the **transport provider** — a server apply or a seed. Not the user.
 * - {@link TEXT_REPLAY_ORIGIN} — an undo/redo replaying an entry
 *   (`block-text-write.ts`). Not the user either: recording it would put the
 *   replay itself on the stack.
 * - the **binding**, relayed verbatim by `binding-replica.ts` — every Lexical
 *   edit, typing and surgery alike. This IS the user.
 *
 * So `isLocalEdit(origin) = origin !== provider && origin !== TEXT_REPLAY_ORIGIN`.
 *
 * ## A run
 *
 * - `beforeTransaction`, local origin, no run open ⇒ OPEN one with
 *   `before = runsNow()`. A memo hit on the common path; on a miss the read
 *   hydrates a separate headless replica from `encodeStateAsUpdate`, which
 *   performs no transaction on the source doc, so there is no re-entrancy.
 *   A transaction that then integrates nothing (no `update` event) discards
 *   the run it opened — nothing happened, so nothing is pending.
 * - `update`, local origin ⇒ re-arm the idle timer ({@link TEXT_RUN_IDLE_MS}).
 * - `update`, NON-local origin, mid-run ⇒ ABORT the run and report
 *   `run-aborted`: an entry recorded across a remote apply would carry the
 *   remote text as if the user had typed it, and undoing it would destroy that
 *   text. One lost undo step at a genuinely concurrent moment, never a
 *   destructive entry. (An echo of this client's own flush integrates nothing
 *   and fires no `update`, so it cannot trip this.)
 * - {@link closeRun} — the idle timer, a pending-flush before an undo, or an
 *   {@link untracked} scope — reads `after = runsNow()` and emits the edit to
 *   the subscribers when it differs from `before`. Idempotent.
 *
 * ## `untracked(edit)`
 *
 * The suppression scope for a caller that records its OWN data entry around a
 * binding-origin surgery (a split's truncation, a merge's append, an inline
 * autoformat): it closes any open run first, then runs `edit` with every local
 * transaction ignored, so the surgery neither opens a run nor extends one —
 * otherwise each would double-record on top of the structural entry. Because
 * it wraps the real Yjs transaction, the transaction must land SYNCHRONOUSLY
 * inside the scope (`discrete: true` on the Lexical update).
 */

/** The idle window that closes a typing run: the app's coalescing tempo. */
export const TEXT_RUN_IDLE_MS = 500;

/**
 * One closed run, as data: what the block's runs were before it and after it.
 * The whole of a text undo entry — replaying it is bringing the block to
 * `before` (undo) or `after` (redo), on whichever host holds the block then.
 *
 * It carries no caret: where a replay lands it is derived from `before` and
 * `after` alone (`changedSpanEnd` — the end of what the replay changed).
 */
export interface BlockRunsEdit {
  readonly blockId: string;
  readonly before: RichText;
  readonly after: RichText;
}

export interface BlockRunTrackerOptions {
  readonly blockId: string;
  readonly doc: Doc;
  /** The transport provider — the origin of every server apply and seed. */
  readonly providerOrigin: unknown;
  /**
   * The block's runs RIGHT NOW. The owner's generation-memoized read, so a run
   * boundary landing on the same content generation as a projection flush
   * shares one headless read.
   */
  readonly runsNow: () => RichText;
  /** Idle window override for tests; production uses {@link TEXT_RUN_IDLE_MS}. */
  readonly idleMs?: number;
}

interface OpenRun {
  readonly before: RichText;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BlockRunTracker {
  readonly blockId: string;
  private readonly doc: Doc;
  private readonly providerOrigin: unknown;
  private readonly runsNow: () => RichText;
  private readonly idleMs: number;

  private run: OpenRun | null = null;
  /** The run was opened by the transaction currently in progress. */
  private opening = false;
  /** Depth of the {@link untracked} scope; local transactions are ignored while > 0. */
  private suppressDepth = 0;
  private disposed = false;
  private readonly listeners = new Set<(edit: BlockRunsEdit) => void>();

  constructor(opts: BlockRunTrackerOptions) {
    this.blockId = opts.blockId;
    this.doc = opts.doc;
    this.providerOrigin = opts.providerOrigin;
    this.runsNow = opts.runsNow;
    this.idleMs = opts.idleMs ?? TEXT_RUN_IDLE_MS;
    this.doc.on("beforeTransaction", this.onBeforeTransaction);
    this.doc.on("update", this.onUpdate);
    // `afterAllTransactions` is the one doc event that fires AFTER `update`
    // (yjs 13.6: `afterTransaction` and `afterTransactionCleanup` both precede
    // it), so it is where "did the transaction that opened this run integrate
    // anything" can be read off whether the timer got armed.
    this.doc.on("afterAllTransactions", this.onAfterAllTransactions);
  }

  /** The three-origin rule (see the module comment). */
  isLocalEdit(origin: unknown): boolean {
    return origin !== this.providerOrigin && origin !== TEXT_REPLAY_ORIGIN;
  }

  /** Is a typing run open right now? */
  get hasOpenRun(): boolean {
    return this.run !== null;
  }

  private readonly onBeforeTransaction = (tr: Transaction): void => {
    if (this.suppressDepth > 0 || this.run !== null) return;
    if (!this.isLocalEdit(tr.origin)) return;
    this.run = { before: this.runsNow(), timer: null };
    this.opening = true;
  };

  private readonly onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (this.suppressDepth > 0) return;
    const run = this.run;
    if (run === null) return;
    if (this.isLocalEdit(origin)) {
      this.armIdle(run);
      return;
    }
    this.abortRun(run);
  };

  private readonly onAfterAllTransactions = (): void => {
    if (!this.opening) return;
    this.opening = false;
    // Opened by a transaction that integrated nothing: no `update` armed the
    // timer, so there is no run to hold — drop it rather than leave a run open
    // that the next remote apply would "abort" for no reason.
    if (this.run !== null && this.run.timer === null) this.run = null;
  };

  private armIdle(run: OpenRun): void {
    if (run.timer !== null) clearTimeout(run.timer);
    run.timer = setTimeout(() => this.closeRun(), this.idleMs);
  }

  private abortRun(run: OpenRun): void {
    if (run.timer !== null) clearTimeout(run.timer);
    this.run = null;
    this.opening = false;
    undoConflictReportSink.emit({
      reason: "run-aborted",
      blockId: this.blockId,
      direction: null,
      expectedLength: runsLength(run.before),
      actualLength: runsLength(this.runsNow()),
    });
  }

  /**
   * Close the open run, if any, and emit it as a {@link BlockRunsEdit} when it
   * changed anything. Idempotent — the idle timer, the pending flush before an
   * undo and an {@link untracked} scope all call it, in any order.
   */
  closeRun(): void {
    const run = this.run;
    if (run === null) return;
    if (run.timer !== null) clearTimeout(run.timer);
    this.run = null;
    this.opening = false;
    const after = this.runsNow();
    if (runsEqual(run.before, after)) return;
    const edit: BlockRunsEdit = {
      blockId: this.blockId,
      before: run.before,
      after,
    };
    for (const cb of [...this.listeners]) cb(edit);
  }

  /**
   * Run `edit` with every local transaction ignored (see the module comment).
   * Closes any open run FIRST, so the caller's own entry sits above a fully
   * recorded typing run rather than inside it. Re-entrant.
   */
  untracked<T>(edit: () => T): T {
    this.closeRun();
    this.suppressDepth += 1;
    try {
      return edit();
    } finally {
      this.suppressDepth -= 1;
    }
  }

  /** Subscribe to every closed, non-empty run. */
  onRunsEdit(cb: (edit: BlockRunsEdit) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Detach from the doc. An open run is DROPPED, not emitted: the owner is
   * being finalized, which only happens once no binding holds it, and its
   * subscribers are gone with the binding.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const run = this.run;
    if (run !== null && run.timer !== null) clearTimeout(run.timer);
    this.run = null;
    this.doc.off("beforeTransaction", this.onBeforeTransaction);
    this.doc.off("update", this.onUpdate);
    this.doc.off("afterAllTransactions", this.onAfterAllTransactions);
    this.listeners.clear();
  }
}
