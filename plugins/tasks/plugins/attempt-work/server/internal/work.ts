/**
 * The attempt-work authority: one memoized answer to "where does this attempt
 * stand relative to `main`?", assembled from the git reads in `measure.ts` and the
 * DB facts that say WHICH git to read (the attempt's worktree, its conversation
 * set, its lifetime).
 *
 * The pushes ledger appears here exactly once, as `ledgerPushes`, and only ever as
 * corroboration (invariant I3): a row proves a push happened, its absence proves
 * nothing. Nothing in this file concludes "nothing landed" from an empty table.
 */
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { attemptBranchRef } from "@plugins/infra/plugins/worktree/core";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import {
  getAttemptRow,
  listConversationIdsForAttempt,
  listPushesForAttempt,
} from "@plugins/tasks/plugins/tasks-core/server";
import { hasCapability } from "@plugins/conversations/plugins/workspace/core";
import type { AttemptPending, AttemptWork } from "../../core/protocol";
import {
  probeHeadMain,
  probeRefMain,
  readLanded,
  readPendingFromBranchRef,
  readPendingInWorktree,
} from "./measure";
import { attemptWorkEtag } from "./etag";

// A commit cannot predate the attempt that authored it, so the trailer grep is
// bounded to the attempt's own lifetime. The one-hour pad absorbs clock
// adjustment (and a commit whose author/committer date was set by a rebase
// slightly before the attempt started).
const SINCE_PAD_MS = 60 * 60 * 1000;

/** The measurement's inputs, all of them DB facts. */
interface WorkContext {
  /** `null` once worktree-cleanup has reaped the checkout — the branch ref remains. */
  worktreePath: string | null;
  mainRepoRoot: string;
  /** `refs/heads/claude-web/<attemptId>` — derived from the ONE definition. */
  branchRef: string;
  /** Sorted, so it feeds the signature order-independently. */
  convIds: string[];
  since: Date;
  ledgerPushes: number;
}

// Unmeasurable when the attempt row is gone. Its conversations went with it (FK
// cascade), so the landed grep has nothing to filter on — the standing is
// genuinely unmeasurable rather than "nothing landed", and both the signature and
// the value say so.
//
// Every read is a TABLE's (`attempts`, `conversations`, `pushes`), never a
// view's: this is a live loader doing git work, and a view's read-set would
// make every task or conversation write recompute it (C36).
//
// An attempt whose workspace has no git (a scratch dir) is unmeasurable by
// construction — no branch, no trailers — the same determinate non-value as a
// gone row: consumers route it to the non-destructive action.
type ContextRead =
  { kind: "ok"; ctx: WorkContext } | { kind: "unmeasurable"; reason: string };

async function readContext(attemptId: string): Promise<ContextRead> {
  const attempt = await getAttemptRow(attemptId);
  if (!attempt) {
    return { kind: "unmeasurable", reason: "attempt no longer exists" };
  }
  if (!hasCapability(attempt.workspace.kind, "git")) {
    return {
      kind: "unmeasurable",
      reason: `a ${attempt.workspace.kind} workspace has no git`,
    };
  }
  const [mainRepoRoot, convIds, pushes] = await Promise.all([
    ensureMainWorktreeRoot(),
    listConversationIdsForAttempt(attemptId),
    listPushesForAttempt(attemptId),
  ]);
  const ctx: WorkContext = {
    worktreePath: attempt.worktreePath,
    mainRepoRoot,
    branchRef: attemptBranchRef(attemptId),
    convIds: [...convIds].sort(),
    since: new Date(attempt.createdAt.getTime() - SINCE_PAD_MS),
    ledgerPushes: pushes.length,
  };
  return { kind: "ok", ctx };
}

// The worktree is the cheapest and most current place to read the tips, but an
// attempt outlives its checkout: `worktreePath` is a DB-held claim about a
// directory that may already be gone. That is a determinate state, not a failed
// read, so it falls through to the branch ref — which still holds the same
// commits. Detected by catching rather than by stat-then-run: a reap racing the
// probe would slip past any pre-check. Every other git failure propagates.
async function probeTips(
  ctx: WorkContext,
): Promise<{ headSha: string; mainSha: string }> {
  if (ctx.worktreePath) {
    try {
      return await probeHeadMain(ctx.worktreePath);
    } catch (err) {
      if (!(err instanceof WorktreeGoneError)) throw err;
    }
  }
  const { headSha, mainSha } = await probeRefMain(
    ctx.mainRepoRoot,
    ctx.branchRef,
  );
  // No ref ⇒ the literal "no-branch", the same determinate answer the measurement
  // reports, so the signature and the value it labels agree.
  return { headSha: headSha ?? "no-branch", mainSha };
}

// Same worktree-gone fall-through as `probeTips`, on the measuring path.
async function readPending(ctx: WorkContext): Promise<AttemptPending> {
  if (ctx.worktreePath) {
    try {
      return await readPendingInWorktree(ctx.worktreePath);
    } catch (err) {
      if (!(err instanceof WorktreeGoneError)) throw err;
    }
  }
  return readPendingFromBranchRef(ctx.mainRepoRoot, ctx.branchRef);
}

/**
 * The measured standing plus the landed shas behind its counts. The shas are kept
 * in the cached value (not recomputed) so the commits-graph pane's rows and the
 * chip's count come from ONE trailer grep.
 */
interface MeasuredWork extends AttemptWork {
  landedShas: string[];
}

// ── the signed memo — one authority for `revalidate` and the loader ─────────
// `createSignedMemo` binds `signature` and `compute` at construction, so the
// resource's `revalidate` and its `loader` are provably the same authority over
// the same inputs. Before this pattern they were two independent call sites
// agreeing only by a comment — the drift that made `edited-files` certify a stale
// value with a fresh ETag, pinning the client on it forever via 304. See
// research/2026-07-09-global-etag-value-coproduction.md.
//
// Keyed by `attemptId` (not by worktree): the value is attempt-scoped — two
// attempts sharing a worktree have different conversation sets and different
// landed commits.
const workMemo = createSignedMemo<Resolvable<MeasuredWork>>({
  name: "attempt-work",
  signature: async (attemptId) => {
    const read = await readContext(attemptId);
    if (read.kind !== "ok") return `unmeasurable:${read.reason}`;
    const { ctx } = read;
    const { headSha, mainSha } = await probeTips(ctx);
    return attemptWorkEtag(headSha, mainSha, ctx.convIds, ctx.ledgerPushes);
  },
  compute: async (attemptId) => {
    const read = await readContext(attemptId);
    if (read.kind !== "ok") return unresolved(read.reason);
    const { ctx } = read;
    // ONE heavy slot for the whole logical job: the pending counts and the landed
    // grep together. The probe above was fully ungated.
    return withHeavyReadSlot(async () => {
      const [pending, landed] = await Promise.all([
        readPending(ctx),
        readLanded(ctx.mainRepoRoot, new Set(ctx.convIds), ctx.since),
      ]);
      return resolved({
        pending,
        landedCommits: landed.shas.length,
        landedPushes: landed.pushIds.length,
        ledgerPushes: ctx.ledgerPushes,
        landedShas: landed.shas,
      });
    });
  },
});

/** The resource's `revalidate`: the memo's own signature, not a twin of it. */
export function attemptWorkSignature(attemptId: string): Promise<string> {
  return workMemo.signature(attemptId);
}

/**
 * The attempt's standing, for any consumer — the resource loader, the exit-drop
 * guard, an MCP tool. A read through the same memo, so an off-subscription caller
 * pays nothing extra when a subscriber has already measured.
 *
 * Projects `landedShas` off the wire payload; `readLandedShas` is the accessor for
 * the shas themselves.
 */
export async function getAttemptWork(
  attemptId: string,
): Promise<Resolvable<AttemptWork>> {
  const m = await workMemo.get(attemptId);
  if (!m.resolved) return m;
  const { pending, landedCommits, landedPushes, ledgerPushes } = m.value;
  return resolved({ pending, landedCommits, landedPushes, ledgerPushes });
}

/**
 * The shas of this attempt's commits that `main` already contains, newest-first —
 * the git-measured replacement for `listPushesForAttempt().map(p => p.sha)`.
 *
 * THROWS when the standing is unmeasurable rather than returning `[]`: an empty
 * array here would be indistinguishable from "this attempt landed nothing", the
 * absorbable failure this plugin exists to remove. Callers that can hold a stale
 * attempt id (a resource loader) branch on the attempt's existence first.
 */
export async function readLandedShas(attemptId: string): Promise<string[]> {
  const m = await workMemo.get(attemptId);
  if (!m.resolved) {
    throw new Error(
      `landed set unmeasurable for attempt ${attemptId}: ${m.reason}`,
    );
  }
  return m.value.landedShas;
}

/** Drop an attempt's cached measurement (subscription-lifecycle cleanup). */
export function evictAttemptWork(attemptId: string): void {
  workMemo.evict(attemptId);
}
