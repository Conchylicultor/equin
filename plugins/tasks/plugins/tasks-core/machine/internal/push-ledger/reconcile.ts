/**
 * The `pushes` ledger as a PROJECTION of `main`'s trailer-bearing history.
 *
 * Every row is derivable from git: `./singularity push` stamps each commit with
 * `Singularity-Conversation` and `Singularity-Push`, and the pre-push
 * `conversation-trailer` check FAILS a push whose commits lack the conversation
 * trailer — so a trailer-bearing commit on `main` is an enforced invariant, not a
 * convention. `main` is only ever fast-forwarded, so its history is a complete
 * record of what landed.
 *
 * That is what makes this a re-derivation rather than an append: running it twice
 * changes nothing, running it late changes nothing but the time, and it needs
 * neither a queue nor a durable job to be correct. See
 * `research/2026-08-18-global-push-ledger-git-projection.md`.
 *
 * This file is the DB-fed orchestration only. The git read (`read-main.ts`), the
 * attribution rules (`plan.ts`) and the walk bound (`walk-bound.ts`) are DB-free
 * so they can be tested directly.
 */
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { insertPush } from "../../../server/internal/mutations/pushes";
import { planLedger } from "../../../server/internal/push-ledger/plan";
import { readMainCommits } from "./read-main";
import { ledgerWalkStart } from "../../../server/internal/push-ledger/walk-bound";
import {
  attemptIdsByConversation,
  existingAttemptIds,
  existingPushShas,
  newestPushCommittedAt,
} from "../../../server/internal/push-ledger/raw-reads";

export interface ReconcileResult {
  /** Trailer-bearing commits the walk considered. */
  scanned: number;
  /** Rows actually inserted. Zero is the steady state, not a failure. */
  inserted: number;
  /** Commits the walk could not attribute. Non-zero is normal in a worktree fork; it is a state, not a failure. */
  deferred: number;
}

/**
 * Re-derive the ledger from `main`, bounded by a COVERAGE frontier.
 *
 * Two bounds, and the earlier wins: the ledger's own high-water mark minus a day
 * (what a backend that was down for a month must catch up on) and a fixed window
 * back from now (in which a commit this database could not attribute yet is
 * re-offered, because an adoption can make it attributable later). Bounding on
 * insertions alone lost such a commit permanently — `./walk-bound.ts` carries the
 * failure and the horizon policy. The bound is still what keeps this cheap enough
 * to sit on the correctness path rather than in a deferred warm-up: a
 * steady-state run walks a month of commits and inserts nothing, a constant as
 * the repo grows. Only an empty ledger pays for the full history, once.
 *
 * Idempotent at three layers — the sha pre-filter in `planLedger`, `insertPush`'s
 * `onConflictDoNothing`, and the `pushes_sha_unique` index under it. Throws on
 * any git or DB failure; the memo in `freshness.ts` is what turns a throw into
 * "retry on the next read" rather than a half-applied walk cached as settled
 * truth.
 */
export async function reconcilePushLedger(): Promise<ReconcileResult> {
  const mainRepoRoot = await ensureMainWorktreeRoot();
  const newest = await newestPushCommittedAt();
  const since = ledgerWalkStart(newest, new Date());
  const commits = await readMainCommits(mainRepoRoot, since);
  if (commits.length === 0) return { scanned: 0, inserted: 0, deferred: 0 };

  const have = await existingPushShas(commits.map((c) => c.sha));
  const attemptByConversation = await attemptIdsByConversation([
    ...new Set(commits.map((c) => c.conversationId)),
  ]);
  const liveAttempts = await existingAttemptIds([
    ...new Set(attemptByConversation.values()),
  ]);

  const { rows, deferred } = planLedger(commits, {
    have,
    attemptByConversation,
    liveAttempts,
  });

  let inserted = 0;
  for (const row of rows) {
    if (await insertPush(row)) inserted += 1;
  }
  return { scanned: commits.length, inserted, deferred: deferred.length };
}
