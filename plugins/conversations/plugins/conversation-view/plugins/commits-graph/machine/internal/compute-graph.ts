import type { CommitRow, CommitsGraph } from "../../shared/protocol";
import {
  runGit,
  LOG_FORMAT,
  parseGitLog,
} from "@plugins/primitives/plugins/commit-list/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import {
  probeHeadMain,
  readBranch,
  readMergeBase,
} from "@plugins/tasks/plugins/attempt-work/server";
import { createInflight } from "@plugins/packages/plugins/inflight/core";

const MAIN = "main";
const MAX_COMMITS = 200;
const MAX_BEHIND = 50;

// Exact, uncapped one-sided commit count (the commit log is capped at
// MAX_COMMITS/MAX_BEHIND, so a count derived from the array would underreport on
// large divergences). Splitting the count this way lets `ahead` live in the
// pending half and `behind` in the behind half, each validated by its own key.
async function readCount(range: string, worktreePath: string): Promise<number> {
  // runGit throws on failure — a failed rev-list must never be absorbed as 0.
  const out = await runGit(["rev-list", "--count", range], worktreePath);
  const n = Number.parseInt(out.trim(), 10);
  if (Number.isNaN(n)) {
    throw new Error(
      `rev-list --count ${range} returned non-numeric output: ${JSON.stringify(out)}`,
    );
  }
  return n;
}

async function computeCommitsFromShas(
  shas: string[],
  worktreePath: string,
): Promise<CommitRow[]> {
  if (shas.length === 0) return [];
  // runGit throws on failure — a failed log must never be absorbed as an empty chain.
  const out = await runGit(
    ["log", "--no-walk", `--format=${LOG_FORMAT}`, ...shas],
    worktreePath,
  );
  return parseGitLog(out);
}

// ── graph: bespoke split-signature two-half cache (Stage 2) ─────────────────
// The graph result is split into two independently-validated halves so a
// `main`-advance (changes behind only; HEAD & merge-base unchanged) reuses the
// expensive pending half. Its two-half structure is genuinely special, so it
// does NOT use the generic single-signature memo; it keeps its own bespoke
// cache + worktree-keyed single-flight.
//
// Keys (each a faithful function of the inputs that half reads):
//   pending : `${headSha}|${mergeBase}`          → { commits, ahead, branch }
//   behind  : `${mainSha}|${mergeBase}`          → { behindCommits, behind }
//   landed  : `${headSha}|${mergeBase}|${landedShasKey}` → { landedCommits }
// landedCommits = the landedShas log filtered to exclude the pending set, so it
// must refresh whenever EITHER the pending set (headSha+mergeBase) OR the landed
// set moves. The landed set is now git-measured (attempt-work greps `main`'s
// Singularity-Conversation trailers) rather than read off the `pushes` ledger, so
// it is keyed by the shas themselves and cannot lag behind a stalled ingest job.

interface PendingHalf {
  key: string;
  commits: CommitRow[];
  ahead: number;
  branch: string | null;
}
interface BehindHalf {
  key: string;
  behindCommits: CommitRow[];
  behind: number;
}
interface LandedPiece {
  key: string;
  landedCommits: CommitRow[];
}

const graphCache = new Map<
  string,
  { pending?: PendingHalf; behind?: BehindHalf; landed?: LandedPiece }
>();
const graphInflight = createInflight();

async function probeGraphState(
  worktreePath: string,
): Promise<{ headSha: string; mainSha: string; mergeBase: string | null }> {
  const { headSha, mainSha } = await probeHeadMain(worktreePath);
  const mergeBase = await readMergeBase(worktreePath);
  return { headSha, mainSha, mergeBase };
}

function landedShasKey(landedShas: string[]): string {
  return [...landedShas].sort().join(",");
}

export async function computeGraph(
  worktreePath: string,
  landedShas: string[] = [],
): Promise<CommitsGraph> {
  const { headSha, mainSha, mergeBase } = await probeGraphState(worktreePath);

  if (mergeBase === null) {
    // No common ancestor with main → empty graph. `branch` is still meaningful;
    // read it ungated (cheap) so the chip can show the branch name.
    const branch = await readBranch(worktreePath);
    return {
      ahead: 0,
      behind: 0,
      mergeBase: null,
      branch,
      commits: [],
      landedCommits: [],
      behindCommits: [],
    };
  }

  const pendingKey = `${headSha}|${mergeBase}`;
  const behindKey = `${mainSha}|${mergeBase}`;
  const landedKey = `${headSha}|${mergeBase}|${landedShasKey(landedShas)}`;

  return graphInflight.run(worktreePath, async () => {
    const entry = graphCache.get(worktreePath) ?? {};
    const pendingHit =
      entry.pending?.key === pendingKey ? entry.pending : undefined;
    const behindHit =
      entry.behind?.key === behindKey ? entry.behind : undefined;
    const landedHit =
      entry.landed?.key === landedKey ? entry.landed : undefined;

    // All three pieces fresh ⇒ assemble from cache with ZERO gated work and NO
    // heavy slot acquired. This is the steady-state no-op notify path.
    if (pendingHit && behindHit && landedHit) {
      return assemble(pendingHit, behindHit, landedHit, mergeBase);
    }

    // Recompute only the stale pieces under a SINGLE heavy slot (one slot per
    // logical job). The probe above was fully ungated; the slot is acquired only
    // here, for exactly the missing `git log`s.
    //
    // Main-advance fast path: a `main` advance moves `mainSha` only — `headSha`
    // and `mergeBase` are unchanged, so `pendingKey` and (for an unchanged
    // landed set) `landedKey` still match. Only `behindHit` is undefined, so
    // the expensive max-200 `mergeBase..HEAD` log below is skipped entirely; the
    // slot wraps just the cheap max-50 `HEAD..main` log.
    const result = await withHeavyReadSlot(async () => {
      const [pending, behind] = await Promise.all([
        pendingHit ?? recomputePending(worktreePath, mergeBase, pendingKey),
        behindHit ?? recomputeBehind(worktreePath, behindKey),
      ]);
      // landed depends on the pending set, so resolve pending first (above),
      // then compute landed against it if its key moved.
      const landed =
        landedHit ??
        (await recomputeLanded(
          worktreePath,
          landedShas,
          pending.commits,
          landedKey,
        ));
      return { pending, behind, landed };
    });

    graphCache.set(worktreePath, {
      pending: result.pending,
      behind: result.behind,
      landed: result.landed,
    });
    return assemble(result.pending, result.behind, result.landed, mergeBase);
  });
}

async function recomputePending(
  worktreePath: string,
  mergeBase: string,
  key: string,
): Promise<PendingHalf> {
  const pendingRange = `${mergeBase}..HEAD`;
  const [out, ahead, branch] = await Promise.all([
    runGit(
      [
        "log",
        `--max-count=${MAX_COMMITS}`,
        `--format=${LOG_FORMAT}`,
        pendingRange,
      ],
      worktreePath,
    ),
    readCount(pendingRange, worktreePath),
    readBranch(worktreePath),
  ]);
  const commits = parseGitLog(out);
  return { key, commits, ahead, branch };
}

async function recomputeBehind(
  worktreePath: string,
  key: string,
): Promise<BehindHalf> {
  const behindRange = `HEAD..${MAIN}`;
  const [out, behind] = await Promise.all([
    runGit(
      [
        "log",
        `--max-count=${MAX_BEHIND}`,
        `--format=${LOG_FORMAT}`,
        behindRange,
      ],
      worktreePath,
    ),
    readCount(behindRange, worktreePath),
  ]);
  const behindCommits = parseGitLog(out);
  return { key, behindCommits, behind };
}

async function recomputeLanded(
  worktreePath: string,
  landedShas: string[],
  pendingCommits: CommitRow[],
  key: string,
): Promise<LandedPiece> {
  const landedAll = await computeCommitsFromShas(landedShas, worktreePath);
  const pendingShaSet = new Set(pendingCommits.map((c) => c.sha));
  const landedCommits = landedAll.filter((c) => !pendingShaSet.has(c.sha));
  return { key, landedCommits };
}

function assemble(
  pending: PendingHalf,
  behind: BehindHalf,
  landed: LandedPiece,
  mergeBase: string,
): CommitsGraph {
  return {
    ahead: pending.ahead,
    behind: behind.behind,
    mergeBase,
    branch: pending.branch,
    commits: pending.commits,
    landedCommits: landed.landedCommits,
    behindCommits: behind.behindCommits,
  };
}

/** Drop a worktree's cached graph state (subscription-lifecycle cleanup). */
export function evictWorktree(worktreePath: string): void {
  graphCache.delete(worktreePath);
}
