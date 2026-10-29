/**
 * The attempt-work authority: one memoized answer to "where does this attempt
 * stand relative to `main`?", assembled from the git reads in `measure.ts` and the
 * DB facts that say WHICH git to read (the attempt's worktree, its conversation
 * set, its lifetime) — handed in as `AttemptFacts`, never read here by a memo.
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
  hasAttemptDelivery,
  listConversationIdsForAttempt,
  listPushesForAttempt,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  hasCapability,
  type WorkspaceKind,
} from "@plugins/conversations/plugins/workspace/core";
import type { AttemptPending, AttemptWork } from "../../core/protocol";
import {
  probeHeadMain,
  probeRefMain,
  readLanded,
  readMainSha,
  readPendingFromBranchRef,
  readPendingInWorktree,
} from "./measure";
import { attemptWorkEtag } from "./etag";

// A commit cannot predate the attempt that authored it, so the trailer grep is
// bounded to the attempt's own lifetime. The one-hour pad absorbs clock
// adjustment (and a commit whose author/committer date was set by a rebase
// slightly before the attempt started).
const SINCE_PAD_MS = 60 * 60 * 1000;

/**
 * The DB facts an attempt's standing is measured from — every one of them, so
 * the measurement itself reads no database. Two producers, one shape:
 *
 * - the live value's followed rows (`../../machine/internal/resource.ts`,
 *   `attemptFactsFrom`) — read through collection tuples, so a write reaches
 *   only the attempts whose facts it moves;
 * - `readAttemptFacts`, the same facts by SQL, for the callers that are not a
 *   resource (the exit-drop guard, the outcome-report MCP tool).
 *
 * Every read is a TABLE's (`attempts`, `conversations`, `pushes`,
 * `attempt_deliveries`), never a view's: a view's read-set would make every
 * task or conversation write reach it (C36).
 */
export interface AttemptFacts {
  /** `null` once the attempt row is gone (its conversations went with it: FK cascade). */
  readonly attempt: {
    readonly workspace: { readonly kind: WorkspaceKind };
    /** `null` once worktree-cleanup has reaped the checkout — the branch ref remains. */
    readonly worktreePath: string | null;
    readonly createdAt: Date;
  } | null;
  /** The attempt's conversations, every kind, in no particular order. */
  readonly convIds: readonly string[];
  /** The push ledger's row count for the attempt — corroboration only (I3). */
  readonly ledgerPushes: number;
  /** Whether the attempt recorded a non-push delivery (a scratch workspace's standing). */
  readonly delivered: boolean;
}

/**
 * The followed rows of `attemptWorkServed`, as facts: the attempt's lookup
 * row (absent once it is gone), its conversation and push id sets, its
 * delivery row (present iff one was recorded).
 */
export function attemptFactsFrom(followed: {
  readonly attempt: readonly NonNullable<AttemptFacts["attempt"]>[];
  readonly convIds: readonly { readonly id: string }[];
  readonly pushIds: readonly unknown[];
  readonly delivery: readonly unknown[];
}): AttemptFacts {
  return {
    attempt: followed.attempt[0] ?? null,
    convIds: followed.convIds.map((c) => c.id),
    ledgerPushes: followed.pushIds.length,
    delivered: followed.delivery.length > 0,
  };
}

/**
 * The same facts by SQL — for a caller that is not a resource. Read whole,
 * so a scratch attempt pays a ledger pull it does not use (memoized: a
 * `main`-tip read when nothing moved); `listPushesForAttempt` pulls the
 * ledger current first, which a follower gets from the feed instead.
 */
export async function readAttemptFacts(
  attemptId: string,
): Promise<AttemptFacts> {
  const [attempt, convIds, pushes, delivered] = await Promise.all([
    getAttemptRow(attemptId),
    listConversationIdsForAttempt(attemptId),
    listPushesForAttempt(attemptId),
    hasAttemptDelivery(attemptId),
  ]);
  return {
    attempt,
    convIds,
    ledgerPushes: pushes.length,
    delivered,
  };
}

/** The measurement's inputs, all derived from the facts. */
interface WorkContext {
  /** `null` once worktree-cleanup has reaped the checkout — the branch ref remains. */
  worktreePath: string | null;
  /** `refs/heads/claude-web/<attemptId>` — derived from the ONE definition. */
  branchRef: string;
  /** What the landed grep reads (see `LandedInput`). */
  landed: LandedInput;
  ledgerPushes: number;
}

// Unmeasurable when the attempt row is gone. Its conversations went with it (FK
// cascade), so the landed grep has nothing to filter on — the standing is
// genuinely unmeasurable rather than "nothing landed", and both the signature and
// the value say so.
//
// An attempt whose workspace has no git (a scratch dir) has no branch and no
// trailers to measure: its standing is its recorded delivery alone
// (`attempt_deliveries`), the fact a scratch agent writes instead of pushing.
// Without that answer a scratch task could never be dropped on close, and would
// stay `attempted` forever.
export type ContextRead =
  | { kind: "ok"; ctx: WorkContext }
  | { kind: "no-git"; delivered: boolean }
  | { kind: "unmeasurable"; reason: string };

/** The measurement's context, a pure function of the facts. */
export function contextFrom(
  attemptId: string,
  facts: AttemptFacts,
): ContextRead {
  const { attempt } = facts;
  if (!attempt) {
    return { kind: "unmeasurable", reason: "attempt no longer exists" };
  }
  if (!hasCapability(attempt.workspace.kind, "git")) {
    return { kind: "no-git", delivered: facts.delivered };
  }
  return {
    kind: "ok",
    ctx: {
      worktreePath: attempt.worktreePath,
      branchRef: attemptBranchRef(attemptId),
      landed: landedInputOf({
        createdAt: attempt.createdAt,
        convIds: facts.convIds,
      }),
      ledgerPushes: facts.ledgerPushes,
    },
  };
}

// The worktree is the cheapest and most current place to read the tips, but an
// attempt outlives its checkout: `worktreePath` is a DB-held claim about a
// directory that may already be gone. That is a determinate state, not a failed
// read, so it falls through to the branch ref — which still holds the same
// commits. Detected by catching rather than by stat-then-run: a reap racing the
// probe would slip past any pre-check. Every other git failure propagates.
async function probeTips(
  ctx: WorkContext,
  mainRepoRoot: string,
): Promise<{ headSha: string; mainSha: string }> {
  if (ctx.worktreePath) {
    try {
      return await probeHeadMain(ctx.worktreePath);
    } catch (err) {
      if (!(err instanceof WorktreeGoneError)) throw err;
    }
  }
  const { headSha, mainSha } = await probeRefMain(mainRepoRoot, ctx.branchRef);
  // No ref ⇒ the literal "no-branch", the same determinate answer the measurement
  // reports, so the signature and the value it labels agree.
  return { headSha: headSha ?? "no-branch", mainSha };
}

// Same worktree-gone fall-through as `probeTips`, on the measuring path.
async function readPending(
  ctx: WorkContext,
  mainRepoRoot: string,
): Promise<AttemptPending> {
  if (ctx.worktreePath) {
    try {
      return await readPendingInWorktree(ctx.worktreePath);
    } catch (err) {
      if (!(err instanceof WorktreeGoneError)) throw err;
    }
  }
  return readPendingFromBranchRef(mainRepoRoot, ctx.branchRef);
}

// ── the landed memo — one trailer grep, shared with commits-graph ───────────
// The landed set (the shas of `main`'s commits carrying the attempt's
// conversation trailers, and their distinct push ids) is a function of
// `main`'s history, the conversation set and the attempt's start — nothing
// else. Its own memo, so the chip's count (attempt-work) and the pane's rows
// (commits-graph's `landedShasFrom`) come from ONE grep however many of the
// two are subscribed, each handing the facts its own follows read.
//
// Keyed by `attemptId` (not by worktree): two attempts sharing a worktree
// have different conversation sets.

/** What the landed grep reads, as the caller holds it. */
interface LandedInput {
  /** Sorted, so it feeds the signature order-independently. */
  readonly convIds: readonly string[];
  readonly since: Date;
}

/** The facts the landed set derives from, as a follower holds them. */
export interface LandedFacts {
  /** The attempt's start — the grep's floor. */
  readonly createdAt: Date;
  /** The attempt's conversations, in any order. */
  readonly convIds: readonly string[];
}

function landedInputOf(facts: LandedFacts): LandedInput {
  return {
    convIds: [...facts.convIds].sort(),
    since: new Date(facts.createdAt.getTime() - SINCE_PAD_MS),
  };
}

const landedMemo = createSignedMemo<
  { shas: string[]; pushIds: string[] },
  LandedInput
>({
  name: "attempt-landed",
  signature: async (_attemptId, input) => {
    const mainSha = await readMainSha(await ensureMainWorktreeRoot());
    return `${mainSha}|${input.since.toISOString()}|${input.convIds.join(",")}`;
  },
  // Reentrant inside attempt-work's own slot (one heavy slot for its whole
  // job); commits-graph's loader enters it here.
  compute: async (_attemptId, input) => {
    const mainRepoRoot = await ensureMainWorktreeRoot();
    return withHeavyReadSlot(() =>
      readLanded(mainRepoRoot, new Set(input.convIds), input.since),
    );
  },
});

/**
 * The shas of this attempt's commits that `main` already contains,
 * newest-first — the landed set of the facts a follower holds (commits-graph:
 * its followed attempt row and conversation set). No "unmeasurable" arm: the
 * facts carry the attempt's start, so a caller holding them holds an attempt
 * that exists.
 */
export async function landedShasFrom(
  attemptId: string,
  facts: LandedFacts,
): Promise<string[]> {
  const landed = await landedMemo.get(attemptId, {
    input: landedInputOf(facts),
  });
  return landed.shas;
}

/** Drop an attempt's cached landed set (subscription-lifecycle cleanup). */
export function evictLandedShas(attemptId: string): void {
  landedMemo.evict(attemptId);
}

// ── the signed memo — one authority for `revalidate` and the loader ─────────
// `createSignedMemo` binds `signature` and `compute` at construction, so the
// resource's `revalidate` and its `loader` are provably the same authority over
// the same inputs. Before this pattern they were two independent call sites
// agreeing only by a comment — the drift that made `edited-files` certify a stale
// value with a fresh ETag, pinning the client on it forever via 304. See
// research/2026-07-09-global-etag-value-coproduction.md.
//
// Its input is the facts: the live value hands it the rows its follows just
// read, a direct caller the SQL read — the memo itself reads no database.
// The value it caches IS the wire payload, so a hit returns the very object
// the last load did, and the runtime's unchanged-value check (D8) sends
// nothing without a walk.
//
// Keyed by `attemptId` (not by worktree): the value is attempt-scoped — two
// attempts sharing a worktree have different conversation sets and different
// landed commits.
const workMemo = createSignedMemo<Resolvable<AttemptWork>, AttemptFacts>({
  name: "attempt-work",
  signature: async (attemptId, facts) => {
    const read = contextFrom(attemptId, facts);
    if (read.kind === "unmeasurable") return `unmeasurable:${read.reason}`;
    if (read.kind === "no-git") return `no-git:${read.delivered}`;
    const { ctx } = read;
    const { headSha, mainSha } = await probeTips(
      ctx,
      await ensureMainWorktreeRoot(),
    );
    return attemptWorkEtag(
      headSha,
      mainSha,
      ctx.landed.convIds,
      ctx.ledgerPushes,
      ctx.worktreePath,
    );
  },
  compute: async (attemptId, facts) => {
    const read = contextFrom(attemptId, facts);
    if (read.kind === "unmeasurable") return unresolved(read.reason);
    if (read.kind === "no-git") {
      return resolved({
        pending: { kind: "no-branch" },
        landedCommits: 0,
        landedPushes: 0,
        ledgerPushes: 0,
        delivered: read.delivered,
      });
    }
    const { ctx } = read;
    const mainRepoRoot = await ensureMainWorktreeRoot();
    // ONE heavy slot for the whole logical job: the pending counts and the landed
    // grep together (the landed memo's own slot is reentrant inside it). The
    // probe above was fully ungated.
    return withHeavyReadSlot(async () => {
      const [pending, landed] = await Promise.all([
        readPending(ctx, mainRepoRoot),
        landedMemo.get(attemptId, { input: ctx.landed }),
      ]);
      return resolved({
        pending,
        landedCommits: landed.shas.length,
        landedPushes: landed.pushIds.length,
        ledgerPushes: ctx.ledgerPushes,
        delivered: false,
      });
    });
  },
});

/** The resource's `revalidate`: the memo's own signature, not a twin of it. */
export function attemptWorkSignature(
  attemptId: string,
  facts: AttemptFacts,
): Promise<string> {
  return workMemo.signature(attemptId, { input: facts });
}

/** The resource's `loader`: a read through the memo, over the followed facts. */
export function attemptWorkFrom(
  attemptId: string,
  facts: AttemptFacts,
): Promise<Resolvable<AttemptWork>> {
  return workMemo.get(attemptId, { input: facts });
}

/**
 * The attempt's standing, for a consumer that is not a resource — the exit-drop
 * guard, an MCP tool: the facts by SQL, then a read through the same memo, so
 * a caller pays nothing extra when a subscriber has already measured the same
 * facts.
 */
export async function getAttemptWork(
  attemptId: string,
): Promise<Resolvable<AttemptWork>> {
  return attemptWorkFrom(attemptId, await readAttemptFacts(attemptId));
}

/** Drop an attempt's cached measurement (subscription-lifecycle cleanup). */
export function evictAttemptWork(attemptId: string): void {
  workMemo.evict(attemptId);
  landedMemo.evict(attemptId);
}
