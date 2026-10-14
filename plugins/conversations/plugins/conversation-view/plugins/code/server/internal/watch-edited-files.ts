import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { acquireCheckoutWatch } from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import { computeEditedFiles } from "./compute-edited-files";
import { editedFilesSignature } from "./edited-files-signature";
import { getEditedFiles } from "./get-edited-files";
import { evictEditedFiles, primeEditedFiles } from "./edited-files-cache";

// One room per watched worktree, however many conversations show it, over the
// shared checkout watch: the working tree AND the git dir, since the list moves
// on a `git add` (untracked → added), and on a `main` advance or rebase (the
// merge-base). The list reads HEAD (its own branch), the index, the working
// tree and `main` — so of the refs every worktree shares it hears only its own
// branch and `refs/heads/main`: another worktree's commit costs nothing.
//
// The checkout watch drops what git ignores (a build's `dist/`, the main
// checkout's `.claude/worktrees/`), so every batch it delivers can move the
// list, and triggers a recompute. The recompute is RETURNED to the checkout
// watch, which runs one at a time per room and folds the batches landing
// mid-run into one trailing recompute — a recompute reads the worktree's
// current state, so N pending ones would be N−1 wasted runs.

interface Room {
  worktreePath: string;
  // The last list the room computed, serialized; null = never computed. A
  // recompute that lands on the same list notifies nobody.
  serialized: string | null;
  closed: boolean;
}

const rooms = createRefcountHub<void>(async (worktreePath, emit) => {
  const room: Room = { worktreePath, serialized: null, closed: false };
  const release = await acquireCheckoutWatch(worktreePath, {
    refs: { also: ["refs/heads/main"] },
    onChange: () =>
      runTracked("watch-edited-files:recompute", () => recompute(room, emit)),
  });
  void runTracked("watch-edited-files:baseline", () => baseline(room));
  return () => {
    room.closed = true;
    // Drop the memo entry with the last subscriber (pure lifecycle cleanup); a
    // re-subscribe repopulates it via the baseline's read-through. A recompute
    // still in flight across this evict is harmless: it write-backs
    // {contentSig, value}, and any later reader probes the CURRENT content
    // signature, so a surviving entry is served only if it genuinely matches.
    evictEditedFiles(worktreePath);
    release();
  };
});

/**
 * Hear the worktree's edited-files list change until the returned stop runs.
 * Resolves once the watch is live. A worktree that is gone has nothing to
 * watch (the loader answers it `unresolved`), so it resolves to a no-op stop.
 */
export async function watchEditedFiles(
  worktreePath: string,
  onChange: () => void,
): Promise<() => void> {
  const hold = rooms.acquire(worktreePath, onChange);
  try {
    await hold.ready;
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    return () => {};
  }
  return hold.release;
}

/**
 * The list the subscribers already hold, so the first change that lands on it
 * notifies nobody. Read THROUGH the memo, without priming: the memo probes its
 * own content signature and caches under it, and its single-flight collapses
 * this read with the subscriber's concurrent loader read into one git batch.
 */
async function baseline(room: Room): Promise<void> {
  try {
    const serialized = JSON.stringify(await getEditedFiles(room.worktreePath));
    // A recompute that landed first holds a newer list.
    if (room.serialized === null) room.serialized = serialized;
  } catch (err) {
    // Gone: the loader answers it, and a recompute will notify.
    if (!(err instanceof WorktreeGoneError)) throw err;
  }
}

async function recompute(room: Room, emit: () => void): Promise<void> {
  let serialized: string;
  try {
    // Direct (un-memoized) compute: the watcher must never read its own cache.
    // A memo hit here could be ≤1 event stale (the mid-flight joiner contract),
    // and the watcher FANS THAT OUT — with no further filesystem event, nothing
    // would ever correct it.
    //
    // Ordering contract (the memo's `prime` precondition): capture the
    // signature BEFORE the compute. A change landing mid-compute then leaves
    // the stored signature older than the value it labels, so the next `get`
    // probes a newer signature, misses, and recomputes. That over-invalidates
    // by one needless recompute; it can never serve a torn value under a
    // matching signature.
    //
    // The prime stays BEFORE the unchanged-JSON early return, so the memo
    // always holds the freshly-confirmed list under the freshly-probed
    // signature; the early return only skips the notify.
    const signature = await editedFilesSignature(room.worktreePath);
    const files = await computeEditedFiles(room.worktreePath);
    serialized = JSON.stringify(files);
    primeEditedFiles(room.worktreePath, signature, files);
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    // Reaped while watched: the readers refetch and get `unresolved`.
    evictEditedFiles(room.worktreePath);
    emit();
    return;
  }
  // The last subscriber may have left mid-compute.
  if (room.closed || serialized === room.serialized) return;
  room.serialized = serialized;
  emit();
}
