/**
 * The guarantee: `pushes` covers `main` as this backend last observed it.
 *
 * The ledger has two halves, the same shape `infra/corpus-index` uses for
 * file-derived indexes. The PUSH half is the in-process ref reaction — it runs in
 * every backend the instant `refs/heads/main` moves, with nothing queued in
 * between. The PULL half is this: the reads that could otherwise observe an
 * incomplete ledger re-derive it first.
 *
 * The pull half is what makes the push half optional, and that is the point. A
 * reaction that is skipped (backend down), lost (a missed watcher event) or that
 * throws costs latency, never correctness — so the fact does not depend on any
 * background worker's liveness. That dependency is what left landed work reading
 * as unfinished and, through `task_blocking_v`, kept dependent tasks from
 * launching.
 */
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { lastKnownMainSha } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { attributionGeneration } from "../../../server/internal/push-ledger/attribution";
import { reconcilePushLedger, type ReconcileResult } from "./reconcile";

// The ledger is one global projection of one ref, so the memo has one key. (The
// memo is keyed per-worktree for its usual git-state callers; here the "state"
// being fingerprinted is `main`, which every backend shares.)
const LEDGER_KEY = "pushes";

/**
 * The cheap, ungated fingerprint: `main`'s tip. The watcher tracks
 * `refs/heads/main` in EVERY backend (only the durable `emit` is main-gated), so
 * this is normally a `Map` read. The `rev-parse` fallback covers the window
 * before the watcher has seeded — `lastKnownMainSha()` returning null means "not
 * seeded", never "main unchanged".
 */
async function mainTip(): Promise<string> {
  const known = lastKnownMainSha();
  if (known) return known;
  const root = await ensureMainWorktreeRoot();
  return (await runGit(["rev-parse", "refs/heads/main"], root)).trim();
}

/**
 * The memo's fingerprint, over BOTH of the reconcile's inputs: `main`'s history
 * and this database's attributable conversation set (see ./attribution.ts).
 *
 * A signature over the tip alone is not a fingerprint of the compute — it is a
 * fingerprint of half of it, and the memo's contract is the whole. That half was
 * what left an adoption's commit deferred: the conversation row that made it
 * attributable arrived, the tip had not moved, so the memo answered from cache
 * and the ledger stayed incomplete until some unrelated push advanced `main`.
 */
async function ledgerSignature(): Promise<string> {
  const tip = await mainTip();
  return `${tip}:${attributionGeneration()}`;
}

// A signature hit short-circuits before any heavy slot is acquired, concurrent
// callers collapse onto one execution, and — the part that matters here — the
// memo caches only on success. A reconcile that throws leaves the covered
// signature unadvanced, so the next call retries rather than inheriting a
// half-applied walk as settled truth.
const ledgerMemo = createSignedMemo<ReconcileResult>({
  name: "push-ledger",
  signature: () => ledgerSignature(),
  compute: () => withHeavyReadSlot(() => reconcilePushLedger()),
});

/**
 * Guarantee the ledger covers `main`'s current tip, then return what the last
 * re-derivation did.
 *
 * Free when neither `main` nor this database's conversation set has moved since
 * the last one — which, with the ref reaction running, is the overwhelmingly
 * common case. Throws when git or the
 * database is unreadable: a caller must never be handed a ledger that silently
 * failed to catch up.
 */
export function ensurePushLedgerFresh(): Promise<ReconcileResult> {
  return ledgerMemo.get(LEDGER_KEY);
}
