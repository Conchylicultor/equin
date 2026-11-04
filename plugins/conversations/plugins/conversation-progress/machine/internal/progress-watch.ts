import {
  acquireCheckoutWatch,
  type CheckoutChange,
  type CheckoutWatchRelease,
} from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { PHASE_ORDER, type ConversationPhase } from "../../core";
import { conversationProgress } from "../../server/internal/tables";
import {
  changedAmong,
  isResearchPath,
  mergeBase,
  phaseOfFiles,
  wholeTreePhase,
} from "./phase-git";

/**
 * What a pass has to look at: the worktree-relative paths a watch batch
 * named, or the whole tree (the baseline, or a watch that lost events).
 */
type Pass = { kind: "paths"; paths: string[] } | { kind: "whole" };

/** One followed conversation. `release` is null while the watch opens. */
interface Followed {
  worktreePath: string;
  release: CheckoutWatchRelease | null;
}

const IMPLEMENTATION = PHASE_ORDER.indexOf("implementation");

/**
 * Conversations whose worktree is watched in this process, until their phase
 * reaches implementation (the last one git decides — pushed is
 * `markProgressPushedJob`'s) or they close. In memory: a restart starts over
 * from each conversation's next turn.
 */
const followed = new Map<string, Followed>();

// One pass at a time per conversation, the passes landing meanwhile folded
// into one: the watch's batches and the baseline never race each other's
// read-then-write of the phase.
const passes = createKeyedCoalescer<string, Pass>({ run: runPass });

/** The stored phase's index in PHASE_ORDER; -1 when none is stored yet. */
async function storedPhaseIndex(conversationId: string): Promise<number> {
  const row = await conversationProgress.get(conversationId);
  return row ? PHASE_ORDER.indexOf(row.phase as ConversationPhase) : -1;
}

/**
 * Keep `conversationId`'s phase current from its worktree's changes. Called on
 * every turn; only the first call for a conversation (per process) does work:
 * it opens a checkout watch on the worktree, then classifies the whole tree
 * once as the baseline. From then on each watch batch is checked against git
 * for its own paths only — a turn costs nothing, and a change costs git reads
 * of the files it touched.
 */
export async function followConversation(
  conversationId: string,
): Promise<void> {
  if (followed.has(conversationId)) return;

  const conversation = await getConversation(conversationId);
  if (!conversation?.worktreePath || conversation.status === "done") return;
  if ((await storedPhaseIndex(conversationId)) >= IMPLEMENTATION) return;
  // Re-checked: two turns' runs can both reach here.
  if (followed.has(conversationId)) return;

  const { worktreePath } = conversation;
  const entry: Followed = { worktreePath, release: null };
  followed.set(conversationId, entry);
  try {
    if ((await mergeBase(worktreePath)) === null) {
      // No git checkout (a scratch workspace) or no main: nothing to watch,
      // and nothing can ever be changed against main. Stays followed, so
      // later turns do not probe again.
      await advance(conversationId, "research");
      return;
    }
    const release = await acquireCheckoutWatch(worktreePath, {
      refs: { also: [] },
      onChange: (changes) =>
        passes.run(conversationId, [
          { kind: "paths", paths: worktreePaths(worktreePath, changes) },
        ]),
      onResync: () => passes.trigger(conversationId, [{ kind: "whole" }]),
    });
    if (followed.get(conversationId) !== entry) {
      // Stopped while the watch was opening.
      release();
      return;
    }
    entry.release = release;
  } catch (err) {
    if (followed.get(conversationId) === entry) followed.delete(conversationId);
    if (err instanceof WorktreeGoneError) return;
    throw err;
  }
  // After the watch is live, so a change landing during the baseline is
  // heard by the watch rather than lost between the two. A failed baseline
  // unfollows, so the job's retry (or the next turn) starts over.
  try {
    await passes.run(conversationId, [{ kind: "whole" }]);
  } catch (err) {
    if (followed.get(conversationId) === entry) {
      unfollowConversation(conversationId);
    }
    throw err;
  }
}

/** Stop following `conversationId`: release its watch, if any. */
export function unfollowConversation(conversationId: string): void {
  const entry = followed.get(conversationId);
  if (!entry) return;
  followed.delete(conversationId);
  entry.release?.();
}

/**
 * The worktree-relative paths of a batch's working-tree changes. Git-dir
 * changes (HEAD, the index, a ref) are dropped: they move no file against the
 * base — a commit's files were heard as they were written, and a checkout or
 * reset that rewrites files is heard through those files. The root itself
 * (`""`) is dropped too: as a pathspec it would mean the whole tree.
 */
function worktreePaths(
  worktreePath: string,
  changes: readonly CheckoutChange[],
): string[] {
  const prefix = `${worktreePath}/`;
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.area !== "worktree") continue;
    if (!change.path.startsWith(prefix)) continue;
    const rel = change.path.slice(prefix.length);
    if (rel !== "") paths.add(rel);
  }
  return [...paths];
}

async function runPass(conversationId: string, items: Pass[]): Promise<void> {
  const entry = followed.get(conversationId);
  if (!entry) return;

  const conversation = await getConversation(conversationId);
  if (
    !conversation ||
    conversation.status === "done" ||
    conversation.worktreePath !== entry.worktreePath
  ) {
    unfollowConversation(conversationId);
    return;
  }
  const stored = await storedPhaseIndex(conversationId);
  if (stored >= IMPLEMENTATION) {
    unfollowConversation(conversationId);
    return;
  }

  let phase: ConversationPhase | null;
  try {
    phase = items.some((i) => i.kind === "whole")
      ? await wholeTreePhase(entry.worktreePath)
      : await phaseOfPaths(entry.worktreePath, stored, items);
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    unfollowConversation(conversationId);
    return;
  }
  if (phase !== null) await advance(conversationId, phase, stored);
}

/**
 * The phase the batches' paths prove, or null when none of them could move
 * it: in design, a research/** path changes nothing, so only the others are
 * asked about.
 */
async function phaseOfPaths(
  worktreePath: string,
  stored: number,
  items: readonly Pass[],
): Promise<ConversationPhase | null> {
  const atDesign = stored >= PHASE_ORDER.indexOf("design");
  const candidates = new Set<string>();
  for (const item of items) {
    if (item.kind !== "paths") continue;
    for (const p of item.paths) {
      if (atDesign && isResearchPath(p)) continue;
      candidates.add(p);
    }
  }
  if (candidates.size === 0) return null;
  const base = await mergeBase(worktreePath);
  if (base === null) return null;
  const changed = await changedAmong(worktreePath, base, [...candidates]);
  return changed.length === 0 ? null : phaseOfFiles(changed);
}

/**
 * Store `phase` when it is past the stored one — a phase never goes back —
 * and stop following once git has nothing more to decide.
 */
async function advance(
  conversationId: string,
  phase: ConversationPhase,
  stored?: number,
): Promise<void> {
  const current = stored ?? (await storedPhaseIndex(conversationId));
  const next = PHASE_ORDER.indexOf(phase);
  if (next > current) {
    await conversationProgress.upsert(conversationId, {
      phase,
      source: "heuristic",
    });
  }
  if (Math.max(next, current) >= IMPLEMENTATION) {
    unfollowConversation(conversationId);
  }
}
