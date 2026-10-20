/**
 * Which ledger rows a git walk implies — pure, so the attribution and deferral
 * rules are pinned by a test rather than inferred from a DB-backed run.
 */
import type { TrailerCommit } from "../../../core";
import type { InsertPushInput } from "../mutations/pushes";

/** What this database knows, against which a walk is attributed. */
export interface LedgerState {
  /** Shas the ledger already holds. */
  have: ReadonlySet<string>;
  /** conversationId → attemptId, for the conversations this database holds. */
  attemptByConversation: ReadonlyMap<string, string>;
  /** Attempt ids that exist here. */
  liveAttempts: ReadonlySet<string>;
}

/** What a walk implies: the rows to write, and the commits left unattributed. */
export interface LedgerPlan {
  /** Rows this database can attribute and does not already hold, oldest first. */
  rows: InsertPushInput[];
  /**
   * Commits the walk saw and could NOT attribute: no conversation row here (and
   * so no attempt to hang the FK on).
   *
   * NAMED, not dropped. From inside this database "foreign, this instance will
   * never own it" and "not mine yet — the conversation row has not been adopted
   * here" are the same observation, so a caller may never treat a deferral as
   * covered: a conversation row can still appear for the second later. What
   * re-offers these commits to a later walk is the walk bound, not this function;
   * see ./walk-bound.ts for the policy and the horizon it stops at.
   */
  deferred: TrailerCommit[];
}

/**
 * Split `commits` into the rows this database can write and the commits it must
 * defer, both oldest first.
 *
 * Oldest-first so a push's commits reach `pushes.landed` subscribers in the order
 * `main` recorded them; `readMainCommits` hands them over newest-first.
 *
 * A commit is DEFERRED when its conversation or attempt is absent here. That is
 * not a failure: a worktree database forked before an attempt existed genuinely
 * has nothing to attach the push to, and inventing a row would break the FK. It
 * is also not final — hence the name, and hence the deferral horizon in
 * ./walk-bound.ts, which is what brings the commit back around. A commit already
 * in `state.have` is neither a row nor a deferral: it is covered.
 */
export function planLedger(
  commits: readonly TrailerCommit[],
  state: LedgerState,
): LedgerPlan {
  const rows: InsertPushInput[] = [];
  const deferred: TrailerCommit[] = [];
  for (let i = commits.length - 1; i >= 0; i--) {
    const commit = commits[i]!;
    if (state.have.has(commit.sha)) continue;
    const attemptId = state.attemptByConversation.get(commit.conversationId);
    if (!attemptId || !state.liveAttempts.has(attemptId)) {
      deferred.push(commit);
      continue;
    }
    rows.push({
      // One push spans many commits, so the ledger's identity is the pair.
      id: `${commit.pushId}:${commit.sha}`,
      attemptId,
      conversationId: commit.conversationId,
      sha: commit.sha,
      pushId: commit.pushId,
      message: commit.subject,
      createdAt: commit.committedAt,
    });
  }
  return { rows, deferred };
}
