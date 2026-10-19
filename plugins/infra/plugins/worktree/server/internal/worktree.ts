import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import {
  spawnCaptured,
  type SpawnResult,
} from "@plugins/infra/plugins/spawn/core";
import { attemptBranchName, attemptBranchRef } from "../../core";
import { namespaceCollision, probeNamespace } from "./composition-namespace";
import { withWorktreeMutateSlot } from "./mutate-gate";
import { isSpareName, SPARE_LOCK_REASON } from "./spare-name";

let cachedRepoRoot: string | null = null;

// Every git subprocess in this file is bounded, because every one of them can be
// reached while the host-wide `worktree-mutate` flock is held: an unbounded child
// there does not hang one caller, it stops worktree checkouts on every backend on
// the machine (the 2026-08-17 outage). The values are ~100× the measured p50 of
// each command, loose enough that only a genuinely wedged child trips them.
//
// Independently of the timeouts, moving off raw `Bun.spawn` is itself the fix for
// the observed wedge: the old code spawned with `{stdout: "pipe", stderr: "pipe"}`
// and then awaited `.exited` WITHOUT EVER READING STDOUT. A child writing more than
// the ~64 KB pipe buffer to an undrained fd blocks forever — a plain deadlock, no
// bug required — and it is also the exact bun 1.3.13 exit-during-stream-pull shape.
// `spawnCaptured` redirects to numeric temp-file fds, which removes both outright.
// THESE ARE WEDGE-BREAKERS, NOT LATENCY POLICE, and they are deliberately far
// looser than "a bit above p99". Every one of them is consumed by a `throw`, and
// a false positive is expensive in both directions: `worktreeListPaths` treats a
// failure as fatal precisely because absence must never be read as evidence
// (see its docblock), and a false timeout on `worktree add` triggers the
// destructive partial-checkout cleanup below. Being late to break a real wedge
// costs one more hourly tick; firing early costs a failed checkout or removal.
//
// Calibrated against measurement, not intuition. `git worktree list --porcelain`
// on this repo (111 worktrees, 76 GB of checkouts) samples at p50 94 ms / p99
// 302 ms / max 585 ms under host load — and a 10 s bound STILL false-fired in a
// real `./singularity check` run, where `ensureMainWorktreeRoot()` is called from
// every parallel type-check worker at once on a saturated box. Starvation, not
// slowness, is what these commands actually suffer, and starvation is unbounded
// by the p99 of an idle box. So each value is ~2-3 orders of magnitude above p50.
const LIST_TIMEOUT_MS = 60_000; // ~640x the 94 ms p50
const ADD_TIMEOUT_MS = 600_000; // ~160x the 3.8 s p50; its false positive is the destructive one
const PRUNE_TIMEOUT_MS = 60_000; // metadata-only, same starvation exposure as list
// Deleting a trashed checkout's files (~16k files plus node_modules). Not a
// wedge detector like the bounds above — it runs OUTSIDE the mutate gate, on a
// tree already out of `.claude/worktrees/`, so a kill here costs nothing but a
// later retry by `emptyWorktreeTrash`. Kept below TRASH_GRACE_MS so a sweep never
// races a removal still deleting its own entry.
const TRASH_RM_TIMEOUT_MS = 30 * 60_000;
const LOCK_TIMEOUT_MS = 60_000; // metadata-only, same starvation exposure as prune
const REF_TIMEOUT_MS = 60_000; // one ref read, same starvation exposure as list
const MOVE_TIMEOUT_MS = 60_000; // a rename + admin-dir rewrite, same exposure as lock

// A git subprocess in this file blew its bound and was KILLED. Its own type,
// not a bare Error, because the distinction is load-bearing for callers: a
// killed child here means a wedge — very likely one that sat on a host-wide
// `worktree-mutate` slot while it hung (the 2026-08-17 outage shape) — whereas a
// nonzero exit is an ordinary git failure. The reaper files a different report
// for each, and the only alternative way to tell them apart would be to match on
// the message text, which is the weakest rung of enforcement for something the
// throw site already knows for certain.
//
// `worktreePath` is the worktree the command was operating on where there is
// one; `worktreeListPaths` reads repo-wide metadata and has none.
export class WorktreeGitTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;
  readonly worktreePath: string | undefined;
  constructor(opts: {
    message: string;
    command: string;
    timeoutMs: number;
    worktreePath?: string;
  }) {
    super(opts.message);
    this.name = "WorktreeGitTimeoutError";
    this.command = opts.command;
    this.timeoutMs = opts.timeoutMs;
    this.worktreePath = opts.worktreePath;
  }
}

// One registered worktree, as `git worktree list --porcelain` describes it.
// `locked` is the lock reason ("" for a bare `locked`), null when unlocked.
export interface WorktreeEntry {
  path: string;
  detached: boolean;
  locked: string | null;
}

// Parse `git worktree list --porcelain`: one blank-line-separated block per
// worktree, in git's own order (the main worktree first).
function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = {
        path: line.slice("worktree ".length).trim(),
        detached: false,
        locked: null,
      };
      entries.push(cur);
    } else if (cur && line === "detached") {
      cur.detached = true;
    } else if (cur && (line === "locked" || line.startsWith("locked "))) {
      cur.locked = line.slice("locked".length).trim();
    }
  }
  return entries;
}

// Every worktree git currently tracks. One parser for every `worktree list
// --porcelain` reader, so "which worktrees does git know about" is answered the
// same way everywhere.
//
// Throws on a nonzero exit rather than reporting an empty list: callers read
// ABSENCE from this list as meaning, so a git failure that degraded to `[]`
// would read as "git tracks nothing" — which in removeWorktree selects the
// recursive-delete branch. A failure here must never be mistaken for evidence.
//
// The tightest bound in the file, because `removeWorktree` calls it from
// INSIDE the mutate gate: a wedge here holds one of three host-wide slots while
// doing nothing but reading metadata.
async function worktreeListEntries(
  argv: string[],
  signal?: AbortSignal,
): Promise<WorktreeEntry[]> {
  const r = await spawnCaptured(argv, { timeoutMs: LIST_TIMEOUT_MS, signal });
  if (r.timedOut) {
    throw new WorktreeGitTimeoutError({
      message:
        `git worktree list did not finish within ${LIST_TIMEOUT_MS} ms and was killed ` +
        `(it may run while a host-wide worktree-mutate slot is held): ${argv.join(" ")}`,
      command: argv.join(" "),
      timeoutMs: LIST_TIMEOUT_MS,
    });
  }
  if (r.exitCode !== 0) {
    throw new Error(
      `git worktree list failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
  return parseWorktreePorcelain(r.stdout);
}

// The absolute paths git currently tracks as worktrees, in git's own order.
async function worktreeListPaths(
  argv: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  return (await worktreeListEntries(argv, signal)).map((e) => e.path);
}

/** Every worktree registered in `repoRoot`, with its HEAD shape and lock. */
export function listWorktreeEntries(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<WorktreeEntry[]> {
  return worktreeListEntries(
    [GIT, "-C", repoRoot, "worktree", "list", "--porcelain"],
    signal,
  );
}

/**
 * Every checkout git tracks on this machine, as absolute paths (the main
 * worktree first). Throws on a git failure, never an empty list.
 */
export function listWorktreePaths(signal?: AbortSignal): Promise<string[]> {
  return worktreeListPaths([GIT, "worktree", "list", "--porcelain"], signal);
}

// The main worktree root (parent of all `.claude/worktrees/*`), not the
// current worktree — `git rev-parse --show-toplevel` would return the latter
// when the server runs inside a worktree.
export async function ensureMainWorktreeRoot(
  signal?: AbortSignal,
): Promise<string> {
  if (cachedRepoRoot) return cachedRepoRoot;
  const [mainPath] = await worktreeListPaths(
    [GIT, "worktree", "list", "--porcelain"],
    signal,
  );
  if (!mainPath) throw new Error("Could not determine main worktree root");
  cachedRepoRoot = mainPath;
  return cachedRepoRoot;
}

// The parent dir every agent worktree lives directly under. The single
// definition that both `worktreePathFor` (construction) and
// `isCanonicalWorktreePath` (validation) derive from, so the two can never
// disagree about where worktrees live.
export function gitWorktreesDir(repoRoot: string): string {
  return join(repoRoot, ".claude", "worktrees");
}

export async function worktreePathFor(id: string): Promise<string> {
  const root = await ensureMainWorktreeRoot();
  return join(gitWorktreesDir(root), id);
}

// The inverse of `worktreePathFor`: a real agent worktree always lives as a
// DIRECT child of `<root>/.claude/worktrees/`. Anything else (the main repo
// root, /tmp, a hand-edited path) is non-canonical — it is not a worktree this
// system created, so it must never be adopted as an attempt nor handed to
// `git worktree remove`.
export function isCanonicalWorktreePath(
  path: string,
  repoRoot: string,
): boolean {
  return dirname(path) === gitWorktreesDir(repoRoot);
}

// Stamped into `.git/worktrees/<name>/locked`, so `git worktree list` says who
// locked it and why rather than leaving a bare marker for a human to explain.
const WORKTREE_LOCK_REASON = "singularity agent worktree";

// One `git worktree lock --reason`, bounded. The outcome is the caller's to
// read: an agent checkout logs a failed lock (see `ensureWorktreeLocked`), a
// spare throws (its lock IS its readiness).
export function lockWorktree(
  repoRoot: string,
  wtPath: string,
  reason: string,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return spawnCaptured(
    [GIT, "-C", repoRoot, "worktree", "lock", wtPath, "--reason", reason],
    { timeoutMs: LOCK_TIMEOUT_MS, signal },
  );
}

/**
 * Lock the checkout so an outside sweep cannot remove it.
 *
 * `<repo>/.claude/worktrees/` is Claude Code's OWN worktree directory, not ours:
 * it sweeps that path periodically and removes any worktree holding no work —
 * which is every one of ours the moment its branch merges. Observed directly in
 * 2026-08: 16 checkouts, every one fully merged, all deleted by a git-aware
 * remover on a cadence no job of ours runs on.
 *
 * A lock is the documented opt-out: the sweep skips a locked worktree and never
 * releases a lock it did not set. So every checkout we create stays locked for
 * its whole life, and `removeWorktree` is the only thing that unlocks it.
 *
 * Idempotent: re-locking an already-locked worktree exits 128 with "is already
 * locked", which IS the state the caller asked for, so it counts as success.
 * That is what lets `setupWorktree` re-assert the lock on every call and
 * self-heal a checkout created before this existed.
 *
 * Any other failure is logged, not thrown — the same trade the prune calls in
 * this file make, and for a sharper reason: this runs AFTER a successful
 * checkout, so throwing would fail `setupWorktree`, and the durable job's retry
 * would take the `existsSync` early return straight back to the same failing
 * lock. An agent that never starts is a worse outcome than an unlocked
 * worktree, which is merely the exposure we have lived with until now.
 */
async function ensureWorktreeLocked(
  repoRoot: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const r = await lockWorktree(repoRoot, wtPath, WORKTREE_LOCK_REASON, signal);
  if (r.exitCode === 0 || r.stderr.includes("is already locked")) return;
  console.warn(
    `[worktree] could not lock ${wtPath} ` +
      `(${r.timedOut ? `timed out after ${LOCK_TIMEOUT_MS} ms` : `exit ${r.exitCode}`}): ` +
      `${r.stderr.trim() || "<no stderr>"} — the checkout is exposed to Claude Code's worktree sweep`,
  );
}

// Where a removed checkout goes before its files are deleted: a sibling of
// `.claude/worktrees/`, so on the same volume (the rename is atomic and instant)
// and outside the directory every checkout scanner enumerates.
export function worktreeTrashDir(repoRoot: string): string {
  return join(repoRoot, ".claude", "worktree-trash");
}

// How long a trash entry is left to the removal that created it. Past this, the
// entry is a leftover (its rm was killed, its process died) and
// `emptyWorktreeTrash` deletes it.
const TRASH_GRACE_MS = 60 * 60_000;

// `<ms>-<name>`: the time it was trashed rides in the name, because a rename
// keeps the dir's own mtime, and the same id may be trashed more than once.
function trashEntryName(wtPath: string, now: number): string {
  return `${now}-${basename(wtPath)}`;
}

function trashedAtMs(entry: string): number | undefined {
  const m = /^(\d+)-/.exec(entry);
  return m ? Number(m[1]) : undefined;
}

// Delete one trash entry's files. Demoted to the background tier, because this is
// the heavy disk part of a removal and it no longer holds a mutate slot. A failure
// is logged, not thrown: the checkout is already gone from `.claude/worktrees/`
// and git, so the removal the caller asked for has happened; what is left is
// disk space that `emptyWorktreeTrash` reclaims on the reaper's next sweep.
async function deleteTrashEntry(path: string): Promise<void> {
  const r = await spawnCaptured(["rm", "-rf", path], {
    tier: "background",
    timeoutMs: TRASH_RM_TIMEOUT_MS,
  });
  if (r.timedOut || r.exitCode !== 0) {
    console.warn(
      `[worktree] deleting trashed checkout ${path} did not finish ` +
        `(${r.timedOut ? `timed out after ${TRASH_RM_TIMEOUT_MS} ms` : `exit ${r.exitCode}`}): ` +
        `${r.stderr.trim() || "<no stderr>"} — the next emptyWorktreeTrash retries it`,
    );
  }
}

/**
 * Delete every trash entry older than the grace period — the files of removals
 * whose own delete was killed or whose process died. Called by the reaper once
 * per sweep. Entries inside the grace period belong to a removal that may still
 * be deleting them, so they are left alone; an entry whose name carries no time
 * is not one `removeWorktree` wrote, but it is in our trash dir, so it goes too.
 */
export async function emptyWorktreeTrash(now: number): Promise<number> {
  const repoRoot = await ensureMainWorktreeRoot();
  const dir = worktreeTrashDir(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let deleted = 0;
  for (const entry of entries) {
    const at = trashedAtMs(entry);
    if (at !== undefined && now - at < TRASH_GRACE_MS) continue;
    await deleteTrashEntry(join(dir, entry));
    deleted++;
  }
  return deleted;
}

/**
 * Release our own lock so the removal that follows can proceed.
 *
 * Mandatory, not tidiness: git refuses to remove a locked worktree even with
 * `--force`, and `git worktree prune` SKIPS a locked registration whose
 * directory is already gone — silently, forever. Without this, locking would
 * trade an external-deletion problem for a leaked-registration one.
 *
 * Deliberately NOT `remove -f -f`, which would bulldoze any lock including one a
 * human set by hand. Unlocking exactly what we locked keeps a lock we could not
 * release loud: the `remove` below then fails and names the lock, rather than
 * this call quietly deciding the lock did not matter.
 */
async function unlockWorktreeForRemoval(
  repoRoot: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const r = await spawnCaptured(
    [GIT, "-C", repoRoot, "worktree", "unlock", wtPath],
    { timeoutMs: LOCK_TIMEOUT_MS, signal },
  );
  // "is not locked" is the desired end state, not a failure.
  if (r.exitCode === 0 || r.stderr.includes("is not locked")) return;
  // Thrown BEFORE the dir moves: `prune` skips a locked registration, so moving
  // the tree away from a lock we could not release would leak its
  // `.git/worktrees` entry silently, forever.
  throw new Error(
    `could not unlock ${wtPath} before removal ` +
      `(${r.timedOut ? `timed out after ${LOCK_TIMEOUT_MS} ms` : `exit ${r.exitCode}`}): ` +
      `${r.stderr.trim() || "<no stderr>"}`,
  );
}

/**
 * Whether the attempt's branch already exists in the main repo.
 *
 * `git worktree add -b` creates the branch BEFORE it writes the checkout, so an
 * add that dies part-way leaves the branch standing with no checkout — git's own
 * cleanup deletes the half-written directory and keeps the branch. That is the
 * state a backend restart produces (the gateway signals the backend's whole
 * process group, so the checkout child dies with it), and a retry that runs
 * `add -b` again can only fail with "a branch named … already exists".
 *
 * Throws on anything but "exists" / "does not exist": reading a git failure as
 * "no branch" would pick `-b` and fail the same way, and reading it as "branch
 * exists" would check out a ref we never confirmed.
 */
async function attemptBranchExists(
  repoRoot: string,
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const argv = [
    GIT,
    "-C",
    repoRoot,
    "show-ref",
    "--verify",
    "--quiet",
    attemptBranchRef(id),
  ];
  const r = await spawnCaptured(argv, { timeoutMs: REF_TIMEOUT_MS, signal });
  if (r.timedOut) {
    throw new WorktreeGitTimeoutError({
      message: `git show-ref did not finish within ${REF_TIMEOUT_MS} ms and was killed: ${argv.join(" ")}`,
      command: argv.join(" "),
      timeoutMs: REF_TIMEOUT_MS,
    });
  }
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  throw new Error(
    `git show-ref for ${attemptBranchRef(id)} failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
  );
}

/**
 * The argv prefix every checkout write in this plugin runs under — the cold
 * `worktree add`, the spare refill's `add --detach`, and the claim's `switch`.
 *
 * `checkout.workers=0` (one worker per core): a checkout's cost is the
 * filesystem creating ~16k files (~0.6 ms each), not git — a plain `tar -x` of
 * the same tree takes as long. Writing them in parallel halves the add
 * (measured 10 s → 5 s). `-c` rides GIT_CONFIG_PARAMETERS into the
 * `git reset --hard` child that does the actual write.
 */
export function checkoutGit(cwd: string): string[] {
  return [GIT, "-C", cwd, "-c", "checkout.workers=0"];
}

/**
 * Remove a checkout a killed git child left half-written, and its admin entry.
 *
 * MANDATORY companion to every checkout-writing timeout, not defensive tidiness.
 * `setupWorktree` opens with `if (existsSync(wtPath)) return;` — so a checkout we
 * killed half-way leaves a partial tree that the durable job's next retry reads
 * as "already set up", handing a HALF-POPULATED worktree to `runtime.create`.
 * That is strictly worse than the hang the timeout replaces, so the partial tree
 * must not outlive the kill.
 *
 * Runs INSIDE the caller's gate hold, and deliberately NOT via `removeWorktree`:
 * that re-enters `withWorktreeMutateSlot` and would take a second of the three
 * host-wide slots while we are still holding one.
 *
 * Known gap, accepted: SIGTERM reaches only the direct child. `taskpolicy` execs,
 * so the kill lands on git itself, but git's forked `checkout` / `read-tree`
 * grandchildren survive and may write into the tree we are about to remove.
 * `rm -rf` is idempotent and anything they recreate is an unregistered leftover
 * the reaper's next tick removes.
 */
async function discardPartialCheckout(
  label: string,
  repoRoot: string,
  wtPath: string,
): Promise<void> {
  await rm(wtPath, { recursive: true, force: true });
  // Deliberately NOT signal-bound. This is the cleanup that keeps a killed
  // checkout from leaving a partial tree the next retry reads as finished, so it
  // has to run even when the caller has already been abandoned — cancelling it
  // would trade a released flock for a corrupt worktree. Its own timeout is what
  // makes running it unconditionally safe.
  const pruned = await spawnCaptured(
    [GIT, "-C", repoRoot, "worktree", "prune"],
    {
      tier: "background",
      timeoutMs: PRUNE_TIMEOUT_MS,
    },
  );
  if (pruned.timedOut || pruned.exitCode !== 0) {
    console.warn(
      `[worktree] prune after a discarded partial checkout for ${label} did not succeed ` +
        `(${pruned.timedOut ? "timed out" : `exit ${pruned.exitCode}`}): ` +
        `${pruned.stderr.trim() || "<no stderr>"}`,
    );
  }
}

/**
 * Run one `git worktree add <rest…>` (under `checkoutGit`) and leave no partial
 * checkout behind when it fails. Called inside a mutate-gate hold, by
 * `setupWorktree`'s cold path and by the spare refill.
 */
export async function addCheckout(
  label: string,
  repoRoot: string,
  wtPath: string,
  rest: string[],
  signal?: AbortSignal,
): Promise<void> {
  const argv = [...checkoutGit(repoRoot), "worktree", "add", ...rest];
  // Demoted (`tier: "background"` applies backgroundArgv/darwinbg): a checkout
  // runs in a deferred job — always background work relative to the
  // interactive backends.
  const r = await spawnCaptured(argv, {
    tier: "background",
    timeoutMs: ADD_TIMEOUT_MS,
    signal,
  });
  if (r.timedOut) {
    await discardPartialCheckout(label, repoRoot, wtPath);
    throw new WorktreeGitTimeoutError({
      message:
        `git worktree add for ${label} did not finish within ${ADD_TIMEOUT_MS} ms and was ` +
        `killed; the partial checkout at ${wtPath} was removed so the retry starts clean`,
      command: argv.join(" "),
      timeoutMs: ADD_TIMEOUT_MS,
      worktreePath: wtPath,
    });
  }
  // Fail loudly on a genuine checkout failure so the durable spawn job retries
  // instead of handing `runtime.create` a nonexistent worktree dir (the latent
  // swallowed-failure bug this replaces: the old code awaited `.exited` and
  // ignored `exitCode`). A nonzero exit where the dir now exists is a benign
  // "already exists" race (a concurrent creator won) — treat it as success.
  if (r.exitCode !== 0 && !existsSync(wtPath)) {
    throw new Error(
      `git worktree add for ${label} failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}

/**
 * The spares in `repoRoot` that are READY to claim, oldest first: registered,
 * present on disk, a `spare-*` direct child of the worktrees dir, and locked
 * with `SPARE_LOCK_REASON` — the last step of creating one, so a half-written
 * spare is never listed.
 */
export async function listReadySpares(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const dir = gitWorktreesDir(repoRoot);
  return (await listWorktreeEntries(repoRoot, signal))
    .filter(
      (e) =>
        dirname(e.path) === dir &&
        isSpareName(basename(e.path)) &&
        e.locked === SPARE_LOCK_REASON &&
        existsSync(e.path),
    )
    .map((e) => e.path)
    .sort((a, b) => spareCreatedAt(a) - spareCreatedAt(b));
}

// `spare-<ms>-<rand>` → <ms>. Ordering only; an unparsable name sorts last.
function spareCreatedAt(path: string): number {
  const ms = Number(basename(path).split("-")[1]);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Put a just-moved spare on the attempt's branch: `git switch -c
 * claude-web/<id> main`, or `git switch claude-web/<id>` when the branch already
 * exists (the same convergence the cold add has). A two-tree checkout, so it
 * writes only the diff between the spare's commit and current `main`.
 *
 * Runs only on a freshly moved spare, never to finish a killed one: a switch
 * killed half-way leaves the files it already wrote with HEAD and the index
 * still at the spare's commit, so every file it ADDED is untracked and blocks
 * any later switch ("untracked working tree file would be overwritten") —
 * `--discard-changes` covers tracked changes only. Such a tree is discarded and
 * re-checked-out instead (`convergeExistingCheckout`).
 */
async function switchToAttemptBranch(
  repoRoot: string,
  id: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const branch = attemptBranchName(id);
  const sw = [...checkoutGit(wtPath), "switch"];
  const argv = (await attemptBranchExists(repoRoot, id, signal))
    ? [...sw, branch]
    : [...sw, "-c", branch, "main"];
  const r = await spawnCaptured(argv, {
    tier: "background",
    timeoutMs: ADD_TIMEOUT_MS,
    signal,
  });
  if (r.timedOut) {
    // Same reasoning as a timed-out add: the next retry must start clean (the
    // cold path), not adopt a tree the killed switch left half-written.
    await discardPartialCheckout(id, repoRoot, wtPath);
    throw new WorktreeGitTimeoutError({
      message:
        `git switch in the claimed spare for ${id} did not finish within ${ADD_TIMEOUT_MS} ms ` +
        `and was killed; the partial checkout at ${wtPath} was removed so the retry starts clean`,
      command: argv.join(" "),
      timeoutMs: ADD_TIMEOUT_MS,
      worktreePath: wtPath,
    });
  }
  // Thrown, not absorbed: the dir is at `wtPath` on a detached HEAD, which the
  // retry's early return recognises (`isUnfinishedSpareClaim`), discards and
  // checks out again.
  if (r.exitCode !== 0) {
    throw new Error(
      `git switch to ${branch} in the claimed spare ${wtPath} failed (exit ${r.exitCode}): ` +
        `${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}

/**
 * Claim one ready spare as the attempt's checkout: unlock → `git worktree move`
 * → switch to the attempt branch. Returns false when no spare could be claimed
 * (none ready, or every one taken by a concurrent claimer), so the caller falls
 * back to the cold add. Called inside a mutate-gate hold; the caller locks.
 *
 * Two claimers of one spare are told apart by git itself: the first `unlock`
 * wins (the second sees "is not locked"), and `move` is a rename, so only one
 * can land. The loser tries the next spare.
 */
async function claimSpare(
  repoRoot: string,
  id: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const spare of await listReadySpares(repoRoot, signal)) {
    const unlockArgv = [GIT, "-C", repoRoot, "worktree", "unlock", spare];
    const unlocked = await spawnCaptured(unlockArgv, {
      timeoutMs: LOCK_TIMEOUT_MS,
      signal,
    });
    if (unlocked.timedOut) {
      throw new WorktreeGitTimeoutError({
        message: `git worktree unlock did not finish within ${LOCK_TIMEOUT_MS} ms and was killed: ${unlockArgv.join(" ")}`,
        command: unlockArgv.join(" "),
        timeoutMs: LOCK_TIMEOUT_MS,
        worktreePath: spare,
      });
    }
    // Another claimer unlocked (or already moved) it first.
    if (unlocked.exitCode !== 0) continue;
    const moveArgv = [GIT, "-C", repoRoot, "worktree", "move", spare, wtPath];
    const moved = await spawnCaptured(moveArgv, {
      tier: "background",
      timeoutMs: MOVE_TIMEOUT_MS,
      signal,
    });
    if (moved.timedOut) {
      throw new WorktreeGitTimeoutError({
        message: `git worktree move did not finish within ${MOVE_TIMEOUT_MS} ms and was killed: ${moveArgv.join(" ")}`,
        command: moveArgv.join(" "),
        timeoutMs: MOVE_TIMEOUT_MS,
        worktreePath: wtPath,
      });
    }
    if (moved.exitCode !== 0) {
      // A lost race leaves the spare gone. One still standing failed for
      // another reason: say so, and leave it to the prune (it is unlocked now).
      if (existsSync(spare)) {
        console.warn(
          `[worktree] could not move spare ${spare} to ${wtPath} ` +
            `(exit ${moved.exitCode}): ${moved.stderr.trim() || "<no stderr>"} — falling back`,
        );
      }
      continue;
    }
    await switchToAttemptBranch(repoRoot, id, wtPath, signal);
    return true;
  }
  return false;
}

/**
 * Whether the checkout at `wtPath` is a claimed spare whose switch never landed
 * (a crash between `move` and `switch`): its admin dir is `spare-*` (kept by the
 * move), its HEAD is detached, and it holds no lock (the claim unlocked it, and
 * only a finished claim re-locks). All three, so a working checkout — even one
 * made from a spare, mid-rebase on a detached HEAD — is never touched: a
 * finished claim is locked.
 */
export async function isUnfinishedSpareClaim(
  repoRoot: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let gitFile: string;
  try {
    gitFile = await readFile(join(wtPath, ".git"), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No `.git` file (a leftover) or a `.git` dir (not a linked worktree).
    if (code === "ENOENT" || code === "EISDIR") return false;
    throw err;
  }
  const gitdir = /^gitdir: (.+)$/m.exec(gitFile)?.[1]?.trim();
  if (!gitdir || !isSpareName(basename(gitdir))) return false;
  const entry = (await listWorktreeEntries(repoRoot, signal)).find(
    (e) => e.path === wtPath,
  );
  return entry !== undefined && entry.detached && entry.locked === null;
}

/** Where an attempt's checkout came from: a claimed spare, or a cold add. */
export type CheckoutSource = "spare" | "fresh";

/**
 * The checkout body of `setupWorktree`, run inside its mutate-gate hold: claim a
 * ready spare, else the cold `worktree add`; then lock. Takes `repoRoot` so it
 * can run against any repository.
 */
export async function checkoutAttempt(
  repoRoot: string,
  id: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<CheckoutSource> {
  let source: CheckoutSource = "spare";
  if (!(await claimSpare(repoRoot, id, wtPath, signal))) {
    source = "fresh";
    // Converge from a half-finished earlier try instead of assuming
    // all-or-nothing. The branch is created before the checkout is written, so
    // a killed add leaves "branch, no checkout" — check the existing branch out
    // rather than asking git to create it again. Also the right answer when the
    // branch outlived a reaped checkout: its commits are this attempt's work,
    // and `git worktree add <path> claude-web/<name>` is how one is recovered.
    // Read inside the gate, like the registration check in `removeWorktree`.
    const branch = attemptBranchName(id);
    const rest = (await attemptBranchExists(repoRoot, id, signal))
      ? [wtPath, branch]
      : ["-b", branch, wtPath, "main"];
    await addCheckout(id, repoRoot, wtPath, rest, signal);
  }
  // Locked inside the same gate hold as the checkout that created it: the
  // window between "the directory exists" and "the directory is protected" is
  // exactly the window an outside sweep can take it, so it is closed here
  // rather than after the gate is released.
  await ensureWorktreeLocked(repoRoot, wtPath, signal);
  return source;
}

/** What `setupWorktree` did: claimed a spare, added a fresh checkout, or found one in place. */
export interface WorktreeSetup {
  source: CheckoutSource | "existing";
}

/**
 * The early-return body of `setupWorktree` for a checkout that already exists:
 * re-assert the lock — or, for a spare claim a crash interrupted (see
 * `isUnfinishedSpareClaim`), discard the tree and check the attempt out again.
 *
 * Discarded, never finished in place: the claim may have died anywhere inside
 * its switch (a backend restart kills git with the process group), and a
 * half-applied switch cannot be switched again (see `switchToAttemptBranch`).
 * Nobody has worked in an unfinished claim, so the discard loses nothing, and
 * one rule covers every way the switch can die. Both are checkout writes, so
 * they take the gate; `gate` is `withWorktreeMutateSlot` in production.
 */
export async function convergeExistingCheckout(
  repoRoot: string,
  id: string,
  wtPath: string,
  gate: <T>(fn: () => Promise<T>) => Promise<T>,
  signal?: AbortSignal,
): Promise<WorktreeSetup> {
  if (await isUnfinishedSpareClaim(repoRoot, wtPath, signal)) {
    const source = await gate(async () => {
      await discardPartialCheckout(id, repoRoot, wtPath);
      return checkoutAttempt(repoRoot, id, wtPath, signal);
    });
    return { source };
  }
  await ensureWorktreeLocked(repoRoot, wtPath, signal);
  return { source: "existing" };
}

/**
 * @param compositionIds the ids currently in the composition manifest — the
 * checkout side of the namespace collision guard.
 *
 * REQUIRED, not read here, and both halves of that are deliberate. Required so
 * the guard cannot be skipped by forgetting an argument; not read here because
 * the manifest lives in `config_v2`, whose server barrel resolves its config dir
 * at module eval from this process's runtime namespace, which a CLI process does
 * not have — and the CLI statically reaches this barrel
 * from four commands, so importing it would break every `./singularity` command.
 * `infra/worktree` also has no business knowing what a composition is; the
 * caller, which runs in a backend, does.
 *
 * @param signal ambient cancellation, optional. A job handler passes its
 * `ctx.signal`: it is forwarded to the host-wide `worktree-mutate` acquire AND to
 * every git child below, so giving up on the handler actually frees the flock
 * instead of merely recording that we gave up. Without it, an abandoned checkout
 * keeps one of three host-wide slots for as long as git keeps running.
 *
 * @returns where the checkout came from, so the caller can refill the spare
 * pool after a checkout (`spare` or `fresh`), and skip it when nothing was made.
 */
export async function setupWorktree(
  id: string,
  wtPath: string,
  compositionIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<WorktreeSetup> {
  const repoRoot = await ensureMainWorktreeRoot(signal);
  // Idempotent: an already-present worktree dir means the checkout already
  // landed, so a durable-job retry (or a caller reusing an existing worktree) is
  // a no-op. `worktreePathFor` derives the path purely from the id, so the dir's
  // existence is an authoritative "already set up" signal — with one exception
  // it converges: a spare moved into place whose branch switch never finished.
  //
  // The lock is re-asserted rather than skipped: this is the path every reused
  // and every pre-lock worktree takes, so making it the place the lock is
  // guaranteed means a checkout cannot stay unlocked just because it predates
  // this code or something released its lock.
  if (existsSync(wtPath)) {
    return convergeExistingCheckout(
      repoRoot,
      id,
      wtPath,
      (fn) => withWorktreeMutateSlot(fn, signal),
      signal,
    );
  }

  // A checkout's namespace is its own name (the main composition's prefix
  // elides), so creating a checkout CLAIMS that namespace. Refuse before the
  // checkout exists — after `git worktree add` the collision is two owners
  // sharing one spec dir, one socket and one database, which is not something a
  // later error can undo. Deliberately BELOW the idempotent early return: a
  // checkout that already exists already holds its namespace, and refusing there
  // would break both the durable-job retry and the lock re-assertion above. The
  // composition side of this same guard runs in compose-serve; both call one
  // function so the rule cannot drift.
  const ns = asNamespace(id);
  const collision = namespaceCollision(
    ns,
    { kind: "checkout", name: id },
    probeNamespace(repoRoot, ns, compositionIds),
  );
  if (collision) {
    throw new Error(`Cannot create worktree "${id}": ${collision}`);
  }

  // Gate ONLY the heavy checkout host-wide (the 118 MB / 16k-file disk
  // offender). The idempotent existsSync early-return stays outside the gate —
  // it is cheap and must not hold a slot.
  const source = await withWorktreeMutateSlot(
    () => checkoutAttempt(repoRoot, id, wtPath, signal),
    signal,
  );
  return { source };
}

/**
 * Remove a checkout: atomically out of `.claude/worktrees/`, then its files.
 *
 * Two phases, and the split is the point. Inside the host-wide mutate gate, only
 * metadata work and one rename: unlock our lock, rename the dir into
 * `worktreeTrashDir` (same volume, so atomic and instant), and `git worktree
 * prune` the registration whose dir is now gone. Then, with the slot released,
 * delete the trashed files.
 *
 * This replaced `git worktree remove --force`, which deleted the tree file by
 * file while holding a slot, under a 300 s kill. On a large or busy disk it ran
 * out of time and was killed part-way, leaving a half-deleted checkout in place.
 * That leftover read as dirty (every deleted tracked file is a change), so the
 * reaper's clean path never picked it again: each timeout parked a checkout on
 * disk until the 90-day floor — 66 of them when this landed. With a rename, the
 * checkout is either fully in place or fully gone; there is no half state for a
 * kill to leave behind, and the slow part is retried, not stranded.
 *
 * The branch ref is untouched, as it was with `git worktree remove`: every
 * commit the checkout made survives in the main repo.
 */
export async function removeWorktree(
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const repoRoot = await ensureMainWorktreeRoot(signal);
  // Re-assert the canonical-path invariant here rather than trusting the caller —
  // the dir is about to be moved into the trash and deleted, and the guard must
  // sit at the syscall, not one frame above it.
  if (!isCanonicalWorktreePath(wtPath, repoRoot)) {
    throw new Error(
      `refusing to remove non-canonical worktree path ${wtPath} (not a direct child of ${gitWorktreesDir(repoRoot)})`,
    );
  }
  const trashDir = worktreeTrashDir(repoRoot);
  const trashPath = join(trashDir, trashEntryName(wtPath, Date.now()));
  const trashed = await withWorktreeMutateSlot(async () => {
    // Read INSIDE the gate: registration is exactly the state a concurrent
    // add/remove mutates, so checking it outside would race a holder of the slot.
    // A dir can outlive its registration (a `git worktree prune` after the dir
    // was made unreachable, a repo re-clone); such a leftover has no lock to
    // release, and `git worktree unlock` on it fails with "is not a working tree".
    const registered = (
      await worktreeListPaths(
        [GIT, "-C", repoRoot, "worktree", "list", "--porcelain"],
        signal,
      )
    ).includes(wtPath);
    if (registered) await unlockWorktreeForRemoval(repoRoot, wtPath, signal);

    let moved = false;
    if (existsSync(wtPath)) {
      await mkdir(trashDir, { recursive: true });
      await rename(wtPath, trashPath);
      moved = true;
    }
    // Drops the registration whose dir just left (and any other stale admin
    // entry). Logged rather than thrown, and deliberately NOT signal-bound: the
    // rename above is the removal, already committed to, so failing here would
    // report a completed removal as a failure. A stale admin entry is harmless
    // and the next prune clears it. Its own timeout bounds it instead.
    const pruned = await spawnCaptured(
      [GIT, "-C", repoRoot, "worktree", "prune"],
      {
        tier: "background",
        timeoutMs: PRUNE_TIMEOUT_MS,
      },
    );
    if (pruned.timedOut || pruned.exitCode !== 0) {
      console.warn(
        `[worktree] 'worktree prune' after removing ${wtPath} did not succeed ` +
          `(${pruned.timedOut ? `timed out after ${PRUNE_TIMEOUT_MS} ms` : `exit ${pruned.exitCode}`}): ` +
          `${pruned.stderr.trim() || "<no stderr>"}`,
      );
    }
    return moved;
  }, signal);
  if (trashed) await deleteTrashEntry(trashPath);
}
