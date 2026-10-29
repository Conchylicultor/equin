/**
 * The git reads behind an attempt's standing. Deliberately DB-free: every
 * function here takes the paths, refs and ids it needs, so the measurement is
 * exercisable against a throwaway repo (`measure.test.ts`) with no database and no
 * plugin runtime. The DB-fed orchestration (which attempt, which conversations,
 * the memo) lives in `work.ts`.
 *
 * `readBranch` / `readMergeBase` / `readDeltaCounts` / `probeHeadMain` are lifted
 * from `commits-graph`'s `compute-graph.ts` — same semantics, same reasoning; the
 * `rev` parameter is new and defaults to `HEAD`, so a worktree-side caller reads
 * exactly as before while a reaped attempt can be measured through its branch ref.
 */
import {
  runGit,
  tryRunGit,
  GitError,
} from "@plugins/primitives/plugins/commit-list/server";
import { lastKnownMainSha } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import type { AttemptPending } from "../../core/protocol";
// The trailer grammar lives with the `pushes` table it fills, so the ledger's
// own projection and this git-measured landed set read one definition.
import {
  TRAILER_LOG_FORMAT,
  parseTrailerLog,
} from "@plugins/tasks/plugins/tasks-core/core";

const MAIN = "main";

export async function readBranch(worktreePath: string): Promise<string | null> {
  // runGit throws on a real git failure; a detached HEAD legitimately reports
  // the literal "HEAD" (no branch name) → null.
  const trimmed = (
    await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)
  ).trim();
  if (!trimmed || trimmed === "HEAD") return null;
  return trimmed;
}

export async function readMergeBase(
  cwd: string,
  rev: string = "HEAD",
): Promise<string | null> {
  // `git merge-base` exits 1 legitimately when the branches share no common
  // ancestor — that is a real "no merge-base" answer (→ null), NOT a failure.
  // Any other non-zero exit is a genuine failure and must throw so the caller
  // aborts the recompute and keeps its previous cache (never a "" collision).
  const args = ["merge-base", MAIN, rev];
  const res = await tryRunGit(args, cwd);
  if (!res.ok) {
    if (res.exitCode === 1) return null;
    throw new GitError({
      args,
      cwd,
      exitCode: res.exitCode,
      stderr: res.stderr,
    });
  }
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function readDeltaCounts(
  cwd: string,
  rev: string = "HEAD",
): Promise<{ ahead: number; behind: number }> {
  // `--left-right --count <left>...<right>` prints "<left-only>\t<right-only>".
  // left  = main only  = behind
  // right = the attempt's tip only = ahead
  // runGit throws on failure — a false 0/0 is never manufactured from a failed read.
  const out = await runGit(
    ["rev-list", "--left-right", "--count", `${MAIN}...${rev}`],
    cwd,
  );
  const parts = out.trim().split(/\s+/);
  const behind = Number.parseInt(parts[0] ?? "", 10);
  const ahead = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    throw new Error(
      `rev-list --left-right --count returned unparseable output: ${JSON.stringify(out)}`,
    );
  }
  return { ahead, behind };
}

export async function probeHeadMain(
  worktreePath: string,
): Promise<{ headSha: string; mainSha: string }> {
  // Both reads are the thin ungated `runGit` (a rev-parse is microseconds);
  // `main` is read from git-watcher's in-memory sha when seeded, else an ungated
  // `rev-parse main` (never trust a missing watcher as "main unchanged").
  // runGit throws on failure — a failed read must NEVER coalesce to "" and poison
  // the cache signature (two different failures would collide on the same "|"
  // key). A throw here aborts the memo recompute, retaining the previous entry.
  const headSha = (await runGit(["rev-parse", "HEAD"], worktreePath)).trim();
  const mainSha = await readMainSha(worktreePath);
  return { headSha, mainSha };
}

/**
 * `main`'s tip: git-watcher's in-memory sha when seeded, else an ungated
 * `rev-parse main` in `cwd` (any checkout of the repo) — never trust a missing
 * watcher as "main unchanged". Throws on a failed read.
 */
export async function readMainSha(cwd: string): Promise<string> {
  return lastKnownMainSha() ?? (await runGit(["rev-parse", MAIN], cwd)).trim();
}

/**
 * Does `ref` exist? A probe, so `rev-parse --verify --quiet` exiting 1 is the
 * legitimate "no such ref" answer. Every OTHER non-zero exit throws: a broken
 * repository must not read as a deleted branch, which is precisely the confusion
 * that would offer the destructive drop over measurable commits.
 */
export async function refExists(cwd: string, ref: string): Promise<boolean> {
  const args = ["rev-parse", "--verify", "--quiet", ref];
  const res = await tryRunGit(args, cwd);
  if (res.ok) return true;
  if (res.exitCode === 1) return false;
  throw new GitError({ args, cwd, exitCode: res.exitCode, stderr: res.stderr });
}

/**
 * The tips a branch-ref measurement reads, for the signature. `headSha` is
 * `null` when the ref is gone — the same determinate "no-branch" the measurement
 * itself reports, so signature and value stay one consistent pair.
 */
export async function probeRefMain(
  mainRepoRoot: string,
  ref: string,
): Promise<{ headSha: string | null; mainSha: string }> {
  const mainSha = await readMainSha(mainRepoRoot);
  if (!(await refExists(mainRepoRoot, ref))) return { headSha: null, mainSha };
  const headSha = (await runGit(["rev-parse", ref], mainRepoRoot)).trim();
  return { headSha, mainSha };
}

/**
 * The pending half read from a live worktree: how far its HEAD is ahead of (and
 * behind) `main`.
 *
 * `mergeBase` is reported as measured — `null` means main and this branch share
 * no common ancestor, which is a real answer. The counts are read
 * unconditionally: `rev-list --left-right --count` answers for disjoint
 * histories too, so an absent merge-base never manufactures a `0 ahead` for a
 * branch that in fact holds commits.
 */
export async function readPendingInWorktree(
  worktreePath: string,
): Promise<AttemptPending> {
  const [branch, mergeBase, counts] = await Promise.all([
    readBranch(worktreePath),
    readMergeBase(worktreePath),
    readDeltaCounts(worktreePath),
  ]);
  return {
    kind: "measured",
    ahead: counts.ahead,
    behind: counts.behind,
    branch,
    mergeBase,
  };
}

/**
 * The pending half read from the main repo through the attempt's branch ref —
 * the answer for an attempt whose worktree has been reaped. `git worktree remove`
 * does not delete the branch, so the commits are still there to measure.
 *
 * A missing ref is the DETERMINATE `no-branch` answer (no unpushed commit of this
 * attempt can survive to be lost), never a failure: `refExists` throws on
 * anything that is not a clean "no such ref".
 */
export async function readPendingFromBranchRef(
  mainRepoRoot: string,
  branchRef: string,
): Promise<AttemptPending> {
  if (!(await refExists(mainRepoRoot, branchRef))) return { kind: "no-branch" };
  const [mergeBase, counts] = await Promise.all([
    readMergeBase(mainRepoRoot, branchRef),
    readDeltaCounts(mainRepoRoot, branchRef),
  ]);
  return {
    kind: "measured",
    ahead: counts.ahead,
    behind: counts.behind,
    branch: branchRef.replace(/^refs\/heads\//, ""),
    mergeBase,
  };
}

/**
 * The attempt's commits `main` already contains, found by their trailers rather
 * than by the pushes ledger — so a stalled ingest job cannot make landed work
 * look like no work at all.
 *
 * `main` is only ever fast-forwarded, so its history is a complete, non-lagging
 * record of what landed. The read is bounded by `since` (the attempt's own
 * lifetime) because a commit cannot predate the attempt that authored it.
 *
 * Returns the distinct push ids alongside the shas: one `./equin push`
 * stamps one push-trailer value across every commit it rebases, so the
 * distinct count is the true number of pushes.
 */
export async function readLanded(
  mainRepoRoot: string,
  convIds: ReadonlySet<string>,
  since: Date,
): Promise<{ shas: string[]; pushIds: string[] }> {
  // No conversations ⇒ no commit can carry a matching trailer. A genuinely empty
  // domain, not an absorbed failure: there is nothing for the grep to match.
  if (convIds.size === 0) return { shas: [], pushIds: [] };
  // runGit throws on failure — a failed log must never be absorbed into "nothing
  // landed", which is the exact lie this whole plugin exists to remove.
  const raw = await runGit(
    [
      "log",
      "--no-color",
      `--since=${since.toISOString()}`,
      `--format=${TRAILER_LOG_FORMAT}`,
      "refs/heads/main",
    ],
    mainRepoRoot,
  );
  const mine = parseTrailerLog(raw).filter((c) =>
    convIds.has(c.conversationId),
  );
  return {
    shas: mine.map((c) => c.sha),
    pushIds: [...new Set(mine.map((c) => c.pushId))],
  };
}
