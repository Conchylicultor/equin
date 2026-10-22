import { applyUpdate, Doc } from "yjs";
import { LinkNode } from "@lexical/link";
import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  editYDocState,
  yDocContent,
} from "@plugins/primitives/plugins/collab-doc/core";
import {
  blockDocInit,
  blockDocUpdate,
} from "@plugins/page/plugins/editor-collab/core";
import {
  $spliceRunsInto,
  coalesce,
  runsEqual,
  runsLength,
  xmlTextToRuns,
  type RichText,
} from "../../core";
import { blockTextRunsOptions } from "./block-text-extensions";
import { buildSeedStateFor } from "./block-seed-state";
import { base64ToBytes } from "./live-state-yjs-provider";
import {
  blockDocOwnerOf,
  type BlockDocOwner,
  type BlockDocs,
} from "./collab-session";
import { spliceOpenBlockDoc } from "./block-text-write";
import { undoConflictReportSink } from "./undo-conflict-report";

/**
 * Replay host B — the STORED doc — and the one entry point that picks a host
 * (`research/2026-09-09-page-data-based-text-undo-entries-v2.md` §2.4).
 *
 * A data-based text undo entry can be replayed onto a block that has no
 * mounted editor (a merge target that scrolled away, a block restored by a
 * structural undo before its editor mounted). There is then no canonical doc
 * in process to splice, so the write goes through the server's own two
 * endpoints, exactly as the offscreen merge always has:
 *
 *  1. `doc-init` with the row's `data.text` as the proposed seed — first-writer-
 *     wins, so the response is the AUTHORITATIVE stored state (the surviving
 *     doc when one exists; the seed only for a never-opened block, where the
 *     row IS the truth);
 *  2. read that state's runs, ask the caller what the content should become
 *     RELATIVE to them, and splice headless (`$spliceRunsInto`, the same
 *     alignment host A uses) into a delta;
 *  3. `doc-update` merges the delta server-side; every live subscriber
 *     converges through the resource push.
 *
 * `runs` is a FUNCTION of the authoritative current runs for one reason: a
 * FORWARD write (the unmounted merge's append) must stay relative to what the
 * server holds, never to a row projection that may lag the doc by a second.
 * The un-append is then simply a splice back to the recorded `before`, whose
 * prefix alignment removes exactly the appended suffix — no positional cut.
 *
 * This is the one file of the pair that talks to the server — over the
 * caller's `fetchEndpoint` (the editor's own transport); host A
 * (`block-text-write.ts`) stays pure so the bun suite can load it.
 */

/**
 * A replay could not be written. `cause` is the transport failure — an
 * `EndpointError` for a server rejection, including the 404 a PURGED block
 * answers doc-init with (a merely deleted block is a trash and still answers).
 * `useUndoRedo` runs thunks as a floating promise, so this surfaces as an
 * unhandled rejection and the crash collector files it.
 */
export class BlockTextReplayError extends Error {
  readonly blockId: string;

  constructor(blockId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`text replay on block "${blockId}" failed: ${detail}`, { cause });
    this.name = "BlockTextReplayError";
    this.blockId = blockId;
  }
}

/** What a stored-doc write read and wrote — both authoritative. */
export interface StoredSpliceResult {
  /** The runs the server held before the write (the `runs` callback's input). */
  readonly before: RichText;
  /** The runs the doc holds after it (coalesced `runs(before)`). */
  readonly after: RichText;
}

/**
 * Bring a block's STORED content doc to `runs(current)`, where `current` is
 * the authoritative runs the server holds right now. `seedRuns` is the row's
 * `data.text`, used as the doc-init proposal only when no doc exists yet.
 * Both requests go over `fetchEndpoint` — the editor's transport. Resolves with
 * the runs read and written; throws {@link BlockTextReplayError} when either
 * endpoint refuses.
 */
export async function spliceStoredBlockDoc(
  fetchEndpoint: FetchEndpoint,
  blockId: string,
  seedRuns: RichText,
  runs: (current: RichText) => RichText,
): Promise<StoredSpliceResult> {
  const opts = blockTextRunsOptions();
  const nodes = [LinkNode, ...opts.nodes];
  let stored: { state: string };
  try {
    stored = await fetchEndpoint(
      blockDocInit,
      { id: blockId },
      { body: new Blob([buildSeedStateFor(seedRuns) as BlobPart]) },
    );
  } catch (err) {
    throw new BlockTextReplayError(blockId, err);
  }
  const state = base64ToBytes(stored.state);
  const before = currentRunsOf(state);
  const after = coalesce(runs(before));
  if (runsEqual(before, after)) return { before, after };
  const delta = editYDocState(
    state,
    () => $spliceRunsInto(after, opts.extensions),
    { nodes },
  );
  try {
    await fetchEndpoint(
      blockDocUpdate,
      { id: blockId },
      { body: new Blob([delta as BlobPart]) },
    );
  } catch (err) {
    throw new BlockTextReplayError(blockId, err);
  }
  return { before, after };
}

/** The runs a stored state holds — read through the registry-bound bridge. */
function currentRunsOf(state: Uint8Array): RichText {
  const doc = new Doc();
  applyUpdate(doc, state);
  try {
    return xmlTextToRuns(yDocContent(doc), blockTextRunsOptions());
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// The entry point: pick a host, gate on confirmation, apply
// ---------------------------------------------------------------------------

export interface ApplyBlockRunsArgs {
  /**
   * The editor's transport's content docs: host A is its owner of the block,
   * host B's doc-init / doc-update go over its server's endpoint client.
   */
  readonly docs: BlockDocs;
  readonly blockId: string;
  /** The runs the block must hold after this replay. */
  readonly runs: RichText;
  /**
   * The runs the entry expects to find (its `after` on undo, its `before` on
   * redo). A mismatch is a second writer between record and replay: the
   * replay is applied anyway and a `stale-entry` conflict is reported.
   */
  readonly expected: RichText;
  readonly direction: "undo" | "redo";
  /** Does this editor sync content docs at all? `false` is memory mode. */
  readonly serverSync: boolean;
  /**
   * The row's `data.text`, read at apply time: host B's doc-init proposal for
   * a block the server holds no doc for.
   */
  readonly rowRuns: () => RichText;
  /** Memory mode's write, for a block with no live owner: set the row's text. */
  readonly writeRow: (runs: RichText) => void;
  /** Is the row in server truth (`serverIds`) right now? */
  readonly rowPresent: () => boolean;
  /**
   * Is the row in this client's OWN rows right now (the optimistic overlay
   * included)? With `rowPresent` false, `true` means an optimistic re-create
   * this client dispatched and the server has not confirmed yet — the ONE
   * state worth waiting on. `false` means another writer removed the row (a
   * second tab, an agent's markdown-apply, a purge): nothing this client
   * dispatched will ever bring it into server truth, so waiting would hang.
   */
  readonly rowLive: () => boolean;
  /**
   * Resolve when the row enters server truth — push-based, off the same
   * `serverIds` transition that lifts the doc-init FK gate. Never polled.
   * REJECTS when the optimistic create that put the row in the client's rows
   * is rolled back or denied (the row left `rowLive` without ever entering
   * server truth), or when the editor unmounts — never left pending.
   */
  readonly waitRowPresent: () => Promise<void>;
}

/**
 * Replay one text entry onto a block, wherever the block is
 * (§2.4's table):
 *
 * | state of the block                                   | host                          |
 * | ---------------------------------------------------- | ----------------------------- |
 * | live owner whose doc holds content                   | A, now                        |
 * | live owner, doc empty and not synced (mid-hydration) | wait for its `sync`, then A   |
 * | live owner, block purged (doc-init 404)              | B (whose 404 is the loud error) |
 * | no owner, row in server truth                        | B                             |
 * | no owner, row NOT in server truth, in OUR rows (just re-created) | wait for the row; A if an owner appeared, else B |
 * | no owner, row NOT in server truth, NOT in our rows (another writer trashed it) | B, now |
 * | memory mode, no owner                                | the row's `data.text`         |
 *
 * "Holds content" is `synced || clients > 0`: a pre-seeded, locally
 * authoritative doc is the authority for its block and takes the write like
 * typing would (its updates queue until the doc-init lands). Never doc-init a
 * row the server may not have — that is the 404 a fast redo of a re-created
 * block used to hit.
 *
 * The wait is taken ONLY for a row this client itself re-created: the
 * `serverIds` transition it waits on is the confirmation of that very create.
 * A row that is in neither set was removed by someone else, and no push this
 * client can cause will ever carry it — waiting there wedged the tab's
 * serialized undo queue forever. Host B is the answer instead: `doc-init` on a
 * trashed row returns the surviving doc (a delete is a trash), and on a purged
 * one 404s into {@link BlockTextReplayError}, the designed loud path.
 */
export async function applyBlockRuns(args: ApplyBlockRunsArgs): Promise<void> {
  const owner = liveOwnerOf(args.docs, args.blockId);
  if (owner) return applyThroughOwner(owner, args);
  if (!args.serverSync) {
    args.writeRow(args.runs);
    return;
  }
  if (!args.rowPresent() && args.rowLive()) {
    await args.waitRowPresent();
    const appeared = liveOwnerOf(args.docs, args.blockId);
    if (appeared) return applyThroughOwner(appeared, args);
  }
  await applyThroughStore(args);
}

function liveOwnerOf(docs: BlockDocs, blockId: string): BlockDocOwner | null {
  const owner = blockDocOwnerOf(docs, blockId);
  return owner && owner.isLive ? owner : null;
}

/** Host A, once the owner's doc is authoritative for the block. */
async function applyThroughOwner(
  owner: BlockDocOwner,
  args: ApplyBlockRunsArgs,
): Promise<void> {
  if (!docHoldsContent(owner)) {
    const outcome = await ownerSynced(owner);
    // The owner went away while the answer was pending (its last binding
    // unmounted): resolve the block again from scratch rather than write into
    // a destroyed doc.
    if (outcome === "destroyed") return applyBlockRuns(args);
    // The transport learned the block was PURGED (doc-init 404, terminal): its
    // doc will never sync and never flush, so a splice into it would be a
    // silent loss. The server's own 404 is the loud replay error.
    if (outcome === "gone") return applyThroughStore(args);
  }
  reportIfStale(args, owner.runsNow());
  spliceOpenBlockDoc(owner, args.runs);
}

/** Host B. The `expected` check runs against the AUTHORITATIVE runs it reads. */
async function applyThroughStore(args: ApplyBlockRunsArgs): Promise<void> {
  const { fetchEndpoint } = args.docs.server;
  await spliceStoredBlockDoc(
    fetchEndpoint,
    args.blockId,
    args.rowRuns(),
    (current) => {
      reportIfStale(args, current);
      return args.runs;
    },
  );
}

function docHoldsContent(owner: BlockDocOwner): boolean {
  return owner.provider.isSynced || owner.doc.store.clients.size > 0;
}

type OwnerSyncOutcome = "synced" | "destroyed" | "gone";

/**
 * Resolve on the transport's `sync` announcement — or on the owner's
 * finalization, or on the transport's terminal "block purged" verdict,
 * whichever comes first, so a replay can never hang on a doc nothing will
 * ever hydrate. Every exit is push-based; none is a timer.
 */
function ownerSynced(owner: BlockDocOwner): Promise<OwnerSyncOutcome> {
  return new Promise((resolve) => {
    if (owner.provider.isSynced) {
      resolve("synced");
      return;
    }
    if (owner.provider.isBlockGone) {
      resolve("gone");
      return;
    }
    let done = false;
    const settle = (outcome: OwnerSyncOutcome): void => {
      if (done) return;
      done = true;
      owner.provider.off("sync", onSync);
      offDestroyed();
      offGone();
      resolve(outcome);
    };
    const onSync = (): void => settle("synced");
    owner.provider.on("sync", onSync);
    const offDestroyed = owner.onDestroyed(() => settle("destroyed"));
    const offGone = owner.provider.onBlockGone(() => settle("gone"));
  });
}

function reportIfStale(args: ApplyBlockRunsArgs, current: RichText): void {
  if (runsEqual(current, args.expected)) return;
  undoConflictReportSink.emit({
    reason: "stale-entry",
    blockId: args.blockId,
    direction: args.direction,
    expectedLength: runsLength(args.expected),
    actualLength: runsLength(current),
  });
}
