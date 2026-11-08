import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  access,
  readdir,
  readFile,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  asNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import {
  readCheckoutMinter,
  stampCheckoutMinter,
} from "@plugins/infra/plugins/paths/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { attemptBranchName, attemptBranchRef } from "../../core";
import { namespaceCollision, probeNamespace } from "./composition-namespace";
import {
  type AdoptResult,
  emptyDepStorePool,
  type HarvestResult,
  harvestDepStore,
} from "./dep-store-pool";
import { installCheckout } from "./install-checkout";
import { withWorktreeMutateSlot } from "./mutate-gate";
import { isSpareName, SPARE_LOCK_REASON } from "./spare-name";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

let cachedRepoRoot: AppPath | null = null;

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
// a false positive is expensive in both directions: `listWorktreeEntries` treats a
// failure as fatal precisely because absence must never be read as evidence
// (see its docblock), and a false timeout on a checkout write triggers the
// destructive partial-checkout cleanup below. Being late to break a real wedge
// costs one more hourly tick; firing early costs a failed checkout or removal.
//
// Calibrated against measurement, not intuition. `git worktree list --porcelain`
// on this repo (111 worktrees, 76 GB of checkouts) samples at p50 94 ms / p99
// 302 ms / max 585 ms under host load — and a 10 s bound STILL false-fired in a
// real `./equin check` run, where `ensureMainWorktreeRoot()` is called from
// every parallel type-check worker at once on a saturated box. Starvation, not
// slowness, is what these commands actually suffer, and starvation is unbounded
// by the p99 of an idle box. So each value is ~2-3 orders of magnitude above p50.
// Now bounds the one `rev-parse --git-common-dir` a listing starts with (the
// list itself is read from the admin files) — the same starvation exposure.
const LIST_TIMEOUT_MS = 60_000; // ~640x the 94 ms p50
const ADD_TIMEOUT_MS = 600_000; // ~160x the 3.8 s p50; its false positive is the destructive one
const PRUNE_TIMEOUT_MS = 60_000; // metadata-only, same starvation exposure as list
// Deleting a trashed checkout's files (~16k files plus node_modules). Not a
// wedge detector like the bounds above — it runs OUTSIDE the mutate gate, on a
// tree already out of `.claude/worktrees/`, so a kill here costs nothing but a
// later retry by `emptyWorktreeTrash`. Counted in awake time (spawnCaptured),
// TRASH_GRACE_MS in wall time: a removal whose delete spans a sleep can still be
// at it when a sweep takes the entry as a leftover — two `rm -rf`s of one tree,
// the later one finishing what the first left.
const TRASH_RM_TIMEOUT_MS = 30 * 60_000;
const REF_TIMEOUT_MS = 60_000; // one ref read, same starvation exposure as list

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
// one; `commonGitDir` reads repo-wide metadata and has none.
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

// How a worktree's HEAD stands, read from its `HEAD` file: a symbolic ref
// (`ref`, e.g. `refs/heads/main` — unresolved; a reader that needs the commit
// asks git with it), or a detached commit. `null` while not written yet — an
// add in progress, or one killed before it wrote it.
export type WorktreeHead =
  { kind: "branch"; ref: string } | { kind: "detached"; commit: string };

// One registered worktree, as git's own admin files describe it.
// `locked` is the lock reason ("" for a bare `locked`), null when unlocked;
// `prunable` is git's mark for an unlocked worktree whose directory is gone.
export interface WorktreeEntry {
  /**
   * Where git says the worktree is — anywhere its owner put it (a user's own
   * folder included), so NOT an `AppPath`: an app checkout is re-derived from
   * it (`appCheckoutOf`) before a sync read.
   */
  path: string;
  head: WorktreeHead | null;
  locked: string | null;
  prunable: boolean;
}

// Every worktree is read from its admin files (gitrepository-layout(5)), not
// from `git worktree list`, and the reason is the race the lock functions below
// describe: `worktree list` reads every entry's HEAD through its `commondir`
// and dies ("fatal: failed to read .git/worktrees/<other>/commondir") on an
// entry a concurrent `git worktree add` has created but not yet filled. The
// mutate gate admits three adds at once, so a launch's spare claim, the crash
// convergence, the prune and a removal's registration check all failed beside a
// refill. Nothing here reads `commondir`.
//
// Throws on any read failure but the documented in-flight ones, rather than
// reporting fewer entries: callers read ABSENCE from this list as meaning (in
// removeWorktree, "nothing to unlock"), so a failure must never be mistaken for
// evidence.

// A file's text, or null when it does not exist (yet, or any more) or is still
// empty — git creates each admin file before writing it.
async function readAdminFile(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text === "" ? null : text;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

// A lock is the file's existence; its text is the reason ("" for none).
async function readLock(lockFile: string): Promise<string | null> {
  try {
    return (await readFile(lockFile, "utf8")).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

async function readHead(headFile: string): Promise<WorktreeHead | null> {
  const text = await readAdminFile(headFile);
  if (text === null) return null;
  if (!text.startsWith("ref: ")) return { kind: "detached", commit: text };
  const ref = text.slice("ref: ".length).trim();
  // Under the reftable backend HEAD is this stub and the real HEAD lives in
  // the reftable stack, which this reader does not parse — say so.
  if (ref === "refs/heads/.invalid") {
    throw new Error(
      `${headFile} is the reftable stub: worktree listing reads the files ref backend only`,
    );
  }
  return { kind: "branch", ref };
}

// The common git dir of the repo `cwd` (or the process cwd) is in — one
// rev-parse, which reads this checkout's own `.git` only, never another
// worktree's.
async function commonGitDir(
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const argv = [
    GIT,
    ...(cwd === undefined ? [] : ["-C", cwd]),
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ];
  const r = await spawnCaptured(argv, { timeoutMs: LIST_TIMEOUT_MS, signal });
  if (r.timedOut) {
    throw new WorktreeGitTimeoutError({
      message:
        `git rev-parse did not finish within ${LIST_TIMEOUT_MS} ms and was killed ` +
        `(it may run while a host-wide worktree-mutate slot is held): ${argv.join(" ")}`,
      command: argv.join(" "),
      timeoutMs: LIST_TIMEOUT_MS,
    });
  }
  if (r.exitCode !== 0) {
    throw new Error(
      `git rev-parse --git-common-dir failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
  return r.stdout.trim();
}

// The worktrees registered in the repo whose common git dir is `common`, in
// git's own order: the main worktree first, then the linked ones by admin-dir
// name.
async function readWorktreeEntries(common: string): Promise<WorktreeEntry[]> {
  // A bare repo has no main worktree to read; every repo this app drives is a
  // checkout, whose common dir is its `.git`.
  if (basename(common) !== ".git") {
    throw new Error(
      `${common} is not a checkout's .git dir (a bare repo, or a separate git dir): worktree listing reads checkouts only`,
    );
  }
  const main: WorktreeEntry = {
    path: dirname(common),
    head: await readHead(join(common, "HEAD")),
    locked: null,
    prunable: false,
  };
  const adminRoot = join(common, "worktrees");
  let ids: string[];
  try {
    ids = (await readdir(adminRoot)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [main];
    throw err;
  }
  const linked = await Promise.all(
    ids.map(async (id): Promise<WorktreeEntry | null> => {
      const admin = join(adminRoot, id);
      // Written first by an add (after `locked`): an entry without it is one
      // mid-add or mid-prune — or a stray file — and names no worktree yet.
      // git's own list passes it over the same way.
      const gitdir = await readAdminFile(join(admin, "gitdir"));
      if (gitdir === null) return null;
      // Absolute, or relative to the admin dir under `worktree.useRelativePaths`.
      const dotGit = resolve(admin, gitdir);
      const lockedReason = await readLock(join(admin, "locked"));
      return {
        path: basename(dotGit) === ".git" ? dirname(dotGit) : dotGit,
        head: await readHead(join(admin, "HEAD")),
        locked: lockedReason,
        prunable: lockedReason === null && !(await pathExists(dotGit)),
      };
    }),
  );
  return [main, ...linked.filter((e): e is WorktreeEntry => e !== null)];
}

/** Every worktree registered in `repoRoot`, with its HEAD and lock. */
export async function listWorktreeEntries(
  repoRoot: AppPath,
  signal?: AbortSignal,
): Promise<WorktreeEntry[]> {
  return readWorktreeEntries(await commonGitDir(repoRoot, signal));
}

/**
 * Every checkout git tracks on this machine, as absolute paths (the main
 * worktree first). Throws on a read failure, never an empty list.
 */
export async function listWorktreePaths(
  signal?: AbortSignal,
): Promise<string[]> {
  const entries = await readWorktreeEntries(
    await commonGitDir(undefined, signal),
  );
  return entries.map((e) => e.path);
}

// The main worktree root (parent of all `.claude/worktrees/*`), not the
// current worktree — `git rev-parse --show-toplevel` would return the latter
// when the server runs inside a worktree.
export async function ensureMainWorktreeRoot(
  signal?: AbortSignal,
): Promise<AppPath> {
  if (cachedRepoRoot) return cachedRepoRoot;
  const [mainPath] = await listWorktreePaths(signal);
  if (!mainPath) throw new Error("Could not determine main worktree root");
  // The first entry is the main worktree: the checkout the app runs from.
  cachedRepoRoot = asAppPath(mainPath);
  return cachedRepoRoot;
}

/**
 * Whether `path` exists, asked without blocking the event loop. ENOENT is the
 * only "no"; any other error (a permission refusal, a bad path) propagates.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// The parent dir every agent worktree lives directly under. The single
// definition that both `worktreePathFor` (construction) and
// `isCanonicalWorktreePath` (validation) derive from, so the two can never
// disagree about where worktrees live.
export function gitWorktreesDir(repoRoot: AppPath): AppPath {
  return joinAppPath(repoRoot, ".claude", "worktrees");
}

export async function worktreePathFor(id: string): Promise<AppPath> {
  const root = await ensureMainWorktreeRoot();
  return joinAppPath(gitWorktreesDir(root), id);
}

/**
 * The app's own checkout a stored path names — the main checkout, or an agent
 * worktree directly under `<root>/.claude/worktrees/` — re-derived from the
 * app's own roots, so a sync read of it reads a path the app made; `null` for
 * any other path (a scratch workspace, a hand-made checkout), which is no
 * checkout of the app's.
 */
export async function appCheckoutOf(path: string): Promise<AppPath | null> {
  const root = await ensureMainWorktreeRoot();
  // As git spells it: resolved (no trailing slash), then real (`/var` →
  // `/private/var`, a symlinked home), read off the JS thread.
  const lexical = resolve(path);
  const real = await realpath(lexical).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return lexical;
    throw err;
  });
  for (const candidate of new Set([lexical, real])) {
    if (candidate === root) return root;
    if (isCanonicalWorktreePath(candidate, root))
      return worktreePathFor(basename(candidate));
  }
  return null;
}

// The inverse of `worktreePathFor`: a real agent worktree always lives as a
// DIRECT child of `<root>/.claude/worktrees/`. Anything else (the main repo
// root, /tmp, a hand-edited path) is non-canonical — it is not a worktree this
// system created, so it must never be adopted as an attempt nor handed to
// `git worktree remove`.
export function isCanonicalWorktreePath(
  path: string,
  repoRoot: AppPath,
): boolean {
  return dirname(path) === gitWorktreesDir(repoRoot);
}

// Stamped into `.git/worktrees/<name>/locked`, so `git worktree list` says who
// locked it and why rather than leaving a bare marker for a human to explain.
const WORKTREE_LOCK_REASON = LEGACY_IDS.worktreeLockReason;

// A linked worktree's lock, read and written as the file it is:
// `.git/worktrees/<id>/locked`, holding the reason (gitrepository-layout(5)).
//
// Not `git worktree lock` / `unlock`, and the reason is a race, not taste: both
// resolve their argument through git's list of EVERY worktree, reading each
// one's HEAD, and die ("fatal: failed to read .git/worktrees/<other>/commondir")
// when another worktree's admin dir is half-written by a `git worktree add`
// running at that moment. The mutate gate admits three checkouts at once, so a
// claim's lock could fail on a concurrent spare refill, leaving the attempt's
// checkout unlocked — exposed to Claude Code's worktree sweep (2026-11-02, the
// load-flaky concurrent-claims test). One worktree's lock is that worktree's
// file only; nothing here reads any other worktree's HEAD.

/**
 * The admin dir (`<common>/worktrees/<id>`, `common` the repo's common git
 * dir) registered for the checkout at
 * `wtPath`, found the way git finds it — the entry whose `gitdir` file names
 * `<wtPath>/.git` — so it is found even when the checkout's own `.git` file was
 * never written (an add killed early). An entry whose `gitdir` is not written
 * yet (an add in progress) names nothing and is passed over. Null when none
 * names it: the path is not a registered worktree (or no longer — a spare
 * another claimer moved away).
 */
async function adminDirOf(
  common: string,
  wtPath: string,
): Promise<string | null> {
  const adminRoot = join(common, "worktrees");
  const target = join(wtPath, ".git");
  for (const id of await readdir(adminRoot)) {
    const admin = join(adminRoot, id);
    let gitdir: string;
    try {
      gitdir = (await readFile(join(admin, "gitdir"), "utf8")).trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Not an entry (a stray file), or one mid-add or mid-prune.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    // git writes it absolute, or relative to the admin dir under
    // `worktree.useRelativePaths`.
    if (gitdir !== "" && resolve(admin, gitdir) === target) return admin;
  }
  return null;
}

/**
 * Lock the worktree at `wtPath` with `reason`. Idempotent like `git worktree
 * lock`: an existing lock (whatever its reason) is left as it is, and answered
 * `already-locked`; `unregistered` when `wtPath` is no registered worktree.
 * Any other failure throws.
 */
export async function lockWorktree(
  repoRoot: AppPath,
  wtPath: string,
  reason: string,
): Promise<"locked" | "already-locked" | "unregistered"> {
  const admin = await adminDirOf(join(repoRoot, ".git"), wtPath);
  if (admin === null) return "unregistered";
  const file = join(admin, "locked");
  try {
    // `wx`: created only if absent, so two lockers cannot overwrite each other.
    // Newline-terminated, as git writes it.
    await writeFile(file, `${reason}\n`, { flag: "wx" });
    return "locked";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return "already-locked";
    }
    throw err;
  }
}

/**
 * Unlock the worktree at `wtPath`. Of two unlockers exactly one gets
 * `unlocked` — what tells two claimers of one spare apart; `unregistered` when
 * `wtPath` is no registered worktree. Any other failure throws.
 *
 * The lock is taken away by a `rename` to a name only this call knows, then
 * that file is deleted — NOT by unlinking `locked`: on macOS (APFS) two
 * concurrent `unlink`s of one file BOTH return success, about half the time
 * (2026-11-04, measured across processes as well as on Bun's fs thread pool),
 * so both claimers of a spare moved it. `rename` of one source, like `mkdir`
 * and an `O_EXCL` create, measured exclusive. A crash between the two steps
 * leaves a stray `locked.released-*` in the admin dir, which git ignores and the
 * entry's prune removes with it.
 */
export async function unlockWorktree(
  repoRoot: AppPath,
  wtPath: string,
): Promise<"unlocked" | "not-locked" | "unregistered"> {
  const admin = await adminDirOf(join(repoRoot, ".git"), wtPath);
  if (admin === null) return "unregistered";
  const released = join(admin, `locked.released-${randomUUID()}`);
  try {
    await rename(join(admin, "locked"), released);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "not-locked";
    throw err;
  }
  await unlink(released);
  return "unlocked";
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
 * Idempotent: re-locking an already-locked worktree answers `already-locked`,
 * which IS the state the caller asked for, so it counts as success.
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
  repoRoot: AppPath,
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let failure: string;
  try {
    const r = await lockWorktree(repoRoot, wtPath, WORKTREE_LOCK_REASON);
    if (r !== "unregistered") return;
    failure = "it is not a registered worktree";
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    failure = err.message;
  }
  console.warn(
    `[worktree] could not lock ${wtPath}: ${failure} — the checkout is exposed to Claude Code's worktree sweep`,
  );
}

// Where a removed checkout goes before its files are deleted: a sibling of
// `.claude/worktrees/`, so on the same volume (the rename is atomic and instant)
// and outside the directory every checkout scanner enumerates.
export function worktreeTrashDir(repoRoot: AppPath): AppPath {
  return joinAppPath(repoRoot, ".claude", "worktree-trash");
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
 * whose own delete was killed or whose process died — and every pooled
 * dependency store past its bound (`emptyDepStorePool`). Called by the reaper
 * once per sweep; returns how many of either it deleted. Entries inside the
 * grace period belong to a removal that may still be deleting them, so they
 * are left alone; an entry whose name carries no time is not one
 * `removeWorktree` wrote, but it is in our trash dir, so it goes too.
 */
export async function emptyWorktreeTrash(now: number): Promise<number> {
  const repoRoot = await ensureMainWorktreeRoot();
  let deleted = await emptyDepStorePool(repoRoot, now);
  const dir = worktreeTrashDir(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return deleted;
    throw err;
  }
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
  repoRoot: AppPath,
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  // "not-locked" is the desired end state, not a failure. Anything else throws
  // BEFORE the dir moves: `prune` skips a locked registration, so moving the
  // tree away from a lock we could not release would leak its
  // `.git/worktrees` entry silently, forever.
  if ((await unlockWorktree(repoRoot, wtPath)) === "unregistered") {
    throw new Error(
      `could not unlock ${wtPath} before removal: it is not a registered worktree`,
    );
  }
}

/**
 * Whether the attempt's branch already exists in the main repo.
 *
 * A new-branch add creates the branch BEFORE it writes the checkout (as
 * `git worktree add -b` does), so an add that dies part-way leaves the branch
 * standing with no checkout — the partial-checkout cleanup deletes the
 * half-written directory and keeps the branch. That is the
 * state a backend restart produces (the gateway signals the backend's whole
 * process group, so the checkout child dies with it), and a retry that runs
 * a create-only branch write again can only fail.
 *
 * Throws on anything but "exists" / "does not exist": reading a git failure as
 * "no branch" would pick `-b` and fail the same way, and reading it as "branch
 * exists" would check out a ref we never confirmed.
 */
async function attemptBranchExists(
  repoRoot: AppPath,
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
 * The argv prefix every checkout write in this plugin runs under — the
 * `reset --hard` that writes a new checkout (`addCheckout`: the cold path, the
 * spare refill, the release checkout) and the claim's `switch`.
 *
 * `checkout.workers=0` (one worker per core): a checkout's cost is the
 * filesystem creating ~16k files (~0.6 ms each), not git — a plain `tar -x` of
 * the same tree takes as long. Writing them in parallel halves the add
 * (measured 10 s → 5 s).
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
  repoRoot: AppPath,
  wtPath: string,
): Promise<void> {
  // A killed add still carries git's own `ADD_IN_PROGRESS_LOCK`, and `prune`
  // skips a locked registration — so without this the discard would leave the
  // entry behind and the re-add would refuse ("a missing but locked worktree").
  // Released only when it is that lock, before the dir goes: one we did not
  // expect stays loud (the re-add names it). Not signal-bound, like the prune.
  // Through the common dir, so it works from any checkout of the repo (a
  // release checkout's source may be a linked worktree).
  const common = await commonGitDir(repoRoot);
  const entry = (await readWorktreeEntries(common)).find(
    (e) => e.path === wtPath,
  );
  const admin = await adminDirOf(common, wtPath);
  if (entry?.locked === ADD_IN_PROGRESS_LOCK && admin !== null) {
    await unlink(join(admin, "locked")).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
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

/** What a new checkout's HEAD is — the three shapes `git worktree add` takes. */
export type CheckoutHead =
  /** Detached at the commit `rev` names (`add --detach <path> <rev>`). */
  | { kind: "detached"; rev: string }
  /** On `branch`, which exists (`add <path> <branch>`). */
  | { kind: "branch"; branch: string }
  /** On `branch`, created at `from` (`add -b <branch> <path> <from>`). */
  | { kind: "new-branch"; branch: string; from: string };

// One git command expected to succeed, bounded by `timeoutMs`; its stdout.
async function gitOk(
  argv: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const r = await spawnCaptured(argv, { timeoutMs, signal });
  if (r.timedOut) {
    throw new WorktreeGitTimeoutError({
      message: `git did not finish within ${timeoutMs} ms and was killed: ${argv.join(" ")}`,
      command: argv.join(" "),
      timeoutMs,
    });
  }
  if (r.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
  return r.stdout.trim();
}

// The commit `rev` names in `repoRoot`; throws when it names none.
function resolveCommit(
  repoRoot: AppPath,
  rev: string,
  signal?: AbortSignal,
): Promise<string> {
  return gitOk(
    [
      GIT,
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${rev}^{commit}`,
    ],
    REF_TIMEOUT_MS,
    signal,
  );
}

/**
 * Move the filled admin dir `staging` into `<adminRoot>/<name>` — or
 * `<name>1`, `<name>2`, … when taken, as git numbers its ids — and return
 * where it landed. The id is reserved by an exclusive `mkdir` first, because
 * a `rename` onto an EMPTY directory replaces it: that empty dir could be
 * another adder's, created a moment ago. The rename then replaces our own
 * reservation, so the entry appears whole, in one step.
 */
async function publishAdminEntry(
  staging: string,
  adminRoot: string,
  name: string,
): Promise<string> {
  for (let n = 0; ; n++) {
    const admin = join(adminRoot, n === 0 ? name : `${name}${n}`);
    try {
      await mkdir(admin);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    await rename(staging, admin);
    return admin;
  }
}

/**
 * Create a checkout of `head` at `wtPath`, registered as a linked worktree of
 * `repoRoot` (any checkout of the repo), and leave no partial checkout behind
 * when it fails. Called inside a mutate-gate hold, by `setupWorktree`'s cold
 * path, the spare refill and the release checkout.
 *
 * NOT `git worktree add`, and the reason is the race `listWorktreeEntries`
 * describes: `add` enumerates every worktree (reading each HEAD through its
 * `commondir`) before it writes anything, and dies ("fatal: failed to read
 * .git/worktrees/<other>/commondir") beside another add half-way through
 * writing its admin entry — ours (the gate admits three) or anyone's (Claude
 * Code's own `agent-*` worktrees live in this repo). So the entry is written
 * here, as gitrepository-layout(5) defines it, and nothing reads any other
 * worktree's HEAD but our own race-safe listing:
 *
 * 1. The admin entry (`locked`, `commondir`, `HEAD`, `gitdir`) is filled in a
 *    staging dir and renamed into `.git/worktrees/<id>` — it appears whole, so
 *    no reader, git's included, ever sees it half-written.
 * 2. It carries `ADD_IN_PROGRESS_LOCK` from its first instant, exactly as git's
 *    own add does: `prune` skips it, and crash convergence recognises an add
 *    killed anywhere below (`isUnfinishedCheckout` → `discardPartialCheckout`).
 * 3. The dir and its `.git` file, then `git reset --hard` writes the tree —
 *    the same child `git worktree add` runs, under `checkoutGit`.
 * 4. The lock goes once the tree is written.
 *
 * A crash between 1 and 3 leaves the entry, locked, with no dir: the next add
 * at that path discards it first. What git's add does that this does not: run
 * the `post-checkout` hook (the repo has none) and copy the main worktree's
 * `config.worktree` (it has none).
 */
export async function addCheckout(
  label: string,
  repoRoot: AppPath,
  wtPath: string,
  head: CheckoutHead,
  signal?: AbortSignal,
): Promise<void> {
  // Never written into: an existing dir is someone's checkout (or a retry's
  // to converge), and every cleanup below deletes `wtPath`.
  if (await pathExists(wtPath)) {
    throw new Error(
      `cannot add a checkout for ${label}: ${wtPath} already exists`,
    );
  }
  const common = await commonGitDir(repoRoot, signal);
  const entries = await readWorktreeEntries(common);
  const stale = entries.find((e) => e.path === wtPath);
  if (stale !== undefined) {
    // An add of ours killed before its dir was made, or a registration whose
    // dir went: debris. Anything else (locked by someone) stays loud, as in git.
    if (stale.locked !== ADD_IN_PROGRESS_LOCK && !stale.prunable) {
      throw new Error(
        `cannot add a checkout for ${label}: ${wtPath} is already registered, locked (${stale.locked})`,
      );
    }
    await discardPartialCheckout(label, repoRoot, wtPath);
  }

  let headText: string;
  if (head.kind === "detached") {
    headText = await resolveCommit(repoRoot, head.rev, signal);
  } else {
    const ref = `refs/heads/${head.branch}`;
    if (head.kind === "branch") {
      // git's own refusal (die_if_checked_out), read from the race-safe list
      // — the stale entry at `wtPath` discarded above excepted.
      const holder = entries.find(
        (e) =>
          e.path !== wtPath && e.head?.kind === "branch" && e.head.ref === ref,
      );
      if (holder !== undefined) {
        throw new Error(
          `cannot add a checkout for ${label}: ${head.branch} is already checked out at ${holder.path}`,
        );
      }
      await resolveCommit(repoRoot, ref, signal);
    } else {
      // Created before the checkout, as `add -b` does — `setupWorktree`'s
      // branch probe converges a branch whose checkout never landed. The empty
      // old value makes it create-only.
      const commit = await resolveCommit(repoRoot, head.from, signal);
      await gitOk(
        [
          GIT,
          "-C",
          repoRoot,
          "update-ref",
          "-m",
          `branch: Created from ${head.from}`,
          ref,
          commit,
          "",
        ],
        REF_TIMEOUT_MS,
        signal,
      );
    }
    headText = `ref: ${ref}`;
  }

  // Staged beside `worktrees/`, not in it: nothing enumerates it there, and a
  // crash leaves a stray dir git ignores.
  const adminRoot = join(common, "worktrees");
  await mkdir(adminRoot, { recursive: true });
  const staging = await mkdtemp(join(common, "worktree-add-"));
  let admin: string;
  try {
    await writeFile(join(staging, "locked"), `${ADD_IN_PROGRESS_LOCK}\n`);
    await writeFile(join(staging, "commondir"), "../..\n");
    await writeFile(join(staging, "HEAD"), `${headText}\n`);
    await writeFile(join(staging, "gitdir"), `${join(wtPath, ".git")}\n`);
    admin = await publishAdminEntry(staging, adminRoot, basename(wtPath));
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  await mkdir(dirname(wtPath), { recursive: true });
  try {
    await mkdir(wtPath);
  } catch (err) {
    // Not ours to delete (made since the check above): drop only our entry.
    await rm(admin, { recursive: true, force: true });
    throw err;
  }
  try {
    await writeFile(join(wtPath, ".git"), `gitdir: ${admin}\n`);
    // Demoted (`tier: "background"` applies backgroundArgv/darwinbg): a
    // checkout runs in a deferred job — always background work relative to
    // the interactive backends.
    const argv = [
      ...checkoutGit(wtPath),
      "reset",
      "--hard",
      "--quiet",
      "--no-recurse-submodules",
    ];
    const r = await spawnCaptured(argv, {
      tier: "background",
      timeoutMs: ADD_TIMEOUT_MS,
      signal,
    });
    if (r.timedOut) {
      throw new WorktreeGitTimeoutError({
        message:
          `writing the checkout for ${label} did not finish within ${ADD_TIMEOUT_MS} ms and was ` +
          `killed; the partial checkout at ${wtPath} was removed so the retry starts clean`,
        command: argv.join(" "),
        timeoutMs: ADD_TIMEOUT_MS,
        worktreePath: wtPath,
      });
    }
    // Fail loudly so the durable spawn job retries instead of handing
    // `runtime.create` a half-written worktree.
    if (r.exitCode !== 0) {
      throw new Error(
        `writing the checkout for ${label} failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
      );
    }
    await unlink(join(admin, "locked"));
  } catch (err) {
    // Any failure — a killed or failed write, an abort — leaves no partial
    // tree for a retry to adopt.
    await discardPartialCheckout(label, repoRoot, wtPath);
    throw err;
  }
}

/**
 * The spares in `repoRoot` that are READY to claim, oldest first: registered,
 * present on disk, a `spare-*` direct child of the worktrees dir, and locked
 * with `SPARE_LOCK_REASON` — the last step of creating one, so a half-written
 * spare is never listed.
 */
export async function listReadySpares(
  repoRoot: AppPath,
  signal?: AbortSignal,
): Promise<string[]> {
  const dir = gitWorktreesDir(repoRoot);
  const candidates = (await listWorktreeEntries(repoRoot, signal)).filter(
    (e) =>
      dirname(e.path) === dir &&
      isSpareName(basename(e.path)) &&
      e.locked === SPARE_LOCK_REASON,
  );
  const present = await Promise.all(candidates.map((e) => pathExists(e.path)));
  return candidates
    .filter((_, i) => present[i])
    .map((e) => joinAppPath(dir, basename(e.path)))
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
  repoRoot: AppPath,
  id: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const branch = attemptBranchName(id);
  const sw = [...checkoutGit(wtPath), "switch"];
  let argv: string[];
  if (await attemptBranchExists(repoRoot, id, signal)) {
    // git's "already checked out" refusal (die_if_checked_out) enumerates
    // every worktree's HEAD and dies beside a half-written add (see
    // `addCheckout`), so it is asked of the race-safe list instead and git is
    // told not to ask again. `switch -c` creates the branch: nothing to check.
    const ref = attemptBranchRef(id);
    const holder = (await listWorktreeEntries(repoRoot, signal)).find(
      (e) =>
        e.path !== wtPath && e.head?.kind === "branch" && e.head.ref === ref,
    );
    if (holder !== undefined) {
      throw new Error(
        `cannot switch the claimed spare ${wtPath} to ${branch}: it is already checked out at ${holder.path}`,
      );
    }
    argv = [...sw, "--ignore-other-worktrees", branch];
  } else {
    argv = [...sw, "-c", branch, "main"];
  }
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
  // retry's early return recognises (`isUnfinishedCheckout`), discards and
  // checks out again.
  if (r.exitCode !== 0) {
    throw new Error(
      `git switch to ${branch} in the claimed spare ${wtPath} failed (exit ${r.exitCode}): ` +
        `${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}

/**
 * Move the spare at `spare` — unlocked by this claimer, so its own — to
 * `wtPath`, keeping its admin dir (as `git worktree move` does). Returns false
 * when it is no registered worktree any more.
 *
 * NOT `git worktree move`, which enumerates every worktree and dies beside a
 * half-written add (see `addCheckout`). Its two writes, in the order a crash
 * converges from: the admin `gitdir` first (atomically, by rename), then the
 * dir. A crash between them leaves an unlocked entry naming the absent
 * `wtPath` — prunable: the cold add discards it, and the stranded spare dir,
 * unregistered now, is the prune's. git's own order (the dir first) would
 * leave the dir at `wtPath` with an entry naming its old path, which nothing
 * recognises as unfinished.
 *
 * Unlocked throughout, as `git worktree move` requires: a lock written here
 * would be a lock a losing claimer's `unlock` takes for the spare's.
 */
async function moveClaimedSpare(
  repoRoot: AppPath,
  spare: string,
  wtPath: string,
): Promise<boolean> {
  const admin = await adminDirOf(join(repoRoot, ".git"), spare);
  if (admin === null) return false;
  const tmp = join(admin, "gitdir.tmp");
  await writeFile(tmp, `${join(wtPath, ".git")}\n`);
  await rename(tmp, join(admin, "gitdir"));
  await rename(spare, wtPath);
  // Absolute already, unless written relative (`worktree.useRelativePaths`)
  // — rewritten so it names the admin dir from the new place either way.
  await writeFile(join(wtPath, ".git"), `gitdir: ${admin}\n`);
  return true;
}

/**
 * Claim one ready spare as the attempt's checkout: unlock → move → switch to
 * the attempt branch. Returns false when no spare could be claimed (none ready, or every one taken
 * by a concurrent claimer), so the caller falls back to the cold add. Called
 * inside a mutate-gate hold; the caller locks.
 *
 * Two claimers of one spare are told apart by the filesystem: the first
 * `unlock` wins (the second sees `not-locked`), and the loser tries the next
 * spare.
 */
async function claimSpare(
  repoRoot: AppPath,
  id: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const spare of await listReadySpares(repoRoot, signal)) {
    signal?.throwIfAborted();
    const unlocked = await unlockWorktree(repoRoot, spare);
    // Another claimer unlocked (or already moved) it first.
    if (unlocked !== "unlocked") continue;
    if (!(await moveClaimedSpare(repoRoot, spare, wtPath))) continue;
    await switchToAttemptBranch(repoRoot, id, wtPath, signal);
    return true;
  }
  return false;
}

/**
 * The lock reason a checkout carries while it is being written: git's own
 * `git worktree add` locks its admin dir "initializing" before the checkout is
 * written and unlocks it once complete, and `addCheckout` (which writes the
 * entry itself) does the same. So a worktree still locked with it is a checkout that died
 * mid-write (a backend restart kills git with the process group) — or one
 * still being written.
 */
export const ADD_IN_PROGRESS_LOCK = "initializing";

/**
 * Whether the checkout at `wtPath` was killed before it was finished, so it
 * must be discarded and checked out again rather than adopted:
 *
 * - an add that never completed: `ADD_IN_PROGRESS_LOCK` is still on it (the
 *   tree is partly written — not even the CLI may be there);
 * - a claimed spare whose switch never landed (a crash between the move and
 *   the switch): its admin dir is `spare-*` (kept by the move), its HEAD is
 *   detached, and it holds no lock (the claim unlocked it, and only a finished
 *   claim re-locks). All three, so a working checkout — even one made from a
 *   spare, mid-rebase on a detached HEAD — is never touched: a finished claim
 *   is locked.
 */
export async function isUnfinishedCheckout(
  repoRoot: AppPath,
  wtPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const entry = (await listWorktreeEntries(repoRoot, signal)).find(
    (e) => e.path === wtPath,
  );
  if (entry === undefined) return false;
  if (entry.locked === ADD_IN_PROGRESS_LOCK) return true;
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
  return entry.head?.kind === "detached" && entry.locked === null;
}

/** Where the checkout at a path stands — see {@link checkoutState}. */
export type CheckoutState = "absent" | "unfinished" | "complete";

/**
 * Where the checkout at `wtPath` stands, READ ONLY: `absent` (no dir),
 * `unfinished` (a cut-off add or spare claim — `isUnfinishedCheckout`), else
 * `complete` — its files, not whether it is installed. Unlike `setupWorktree`
 * it never discards, checks out or installs anything:
 * a caller that only waits for a checkout made elsewhere (the spawn, waiting
 * on the `worktree.prepare` child) must not converge one that child may still
 * be writing — only the child converges.
 */
export async function checkoutState(
  repoRoot: AppPath,
  wtPath: string,
  signal?: AbortSignal,
): Promise<CheckoutState> {
  if (!(await pathExists(wtPath))) return "absent";
  return (await isUnfinishedCheckout(repoRoot, wtPath, signal))
    ? "unfinished"
    : "complete";
}

/** Where an attempt's checkout came from: a claimed spare, or a cold add. */
export type CheckoutSource = "spare" | "fresh";

/**
 * The checkout body of `setupWorktree`, run inside its mutate-gate hold: claim a
 * ready spare, else the cold `worktree add`; then lock. Takes `repoRoot` so it
 * can run against any repository.
 */
export async function checkoutAttempt(
  repoRoot: AppPath,
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
    const head: CheckoutHead = (await attemptBranchExists(repoRoot, id, signal))
      ? { kind: "branch", branch }
      : { kind: "new-branch", branch, from: "main" };
    await addCheckout(id, repoRoot, wtPath, head, signal);
  }
  // Locked inside the same gate hold as the checkout that created it: the
  // window between "the directory exists" and "the directory is protected" is
  // exactly the window an outside sweep can take it, so it is closed here
  // rather than after the gate is released.
  await ensureWorktreeLocked(repoRoot, wtPath, signal);
  return source;
}

/** What `setupWorktree` did: claimed a spare, added a fresh checkout, or found one in place — and what its install started from. */
export interface WorktreeSetup {
  source: CheckoutSource | "existing";
  depStore: AdoptResult;
}

/**
 * The early-return body of `setupWorktree` for a checkout that already exists:
 * re-assert the lock — or, for an add or a spare claim a crash interrupted (see
 * `isUnfinishedCheckout`), discard the tree and check the attempt out again.
 *
 * Discarded, never finished in place: the add or claim may have died anywhere
 * inside its checkout (a backend restart kills git with the process group), and
 * a half-applied switch cannot be switched again (see `switchToAttemptBranch`).
 * Nobody has worked in an unfinished checkout, so the discard loses nothing,
 * and one rule covers every way the checkout can die. Both are checkout writes, so
 * they take the gate; `gate` is `withWorktreeMutateSlot` in production.
 */
export async function convergeExistingCheckout(
  repoRoot: AppPath,
  id: string,
  wtPath: string,
  gate: <T>(fn: () => Promise<T>) => Promise<T>,
  signal?: AbortSignal,
): Promise<Pick<WorktreeSetup, "source">> {
  if (await isUnfinishedCheckout(repoRoot, wtPath, signal)) {
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
 * from four commands, so importing it would break every `./equin` command.
 * `infra/worktree` also has no business knowing what a composition is; the
 * caller, which runs in a backend, does.
 *
 * @param minter the namespace whose backend makes this checkout — the one
 * whose database holds its attempt row (`runtimeNamespace()` of the caller).
 * REQUIRED: it is stamped beside the checkout (`stampCheckoutMinter`) so main's
 * reaper can tell a checkout a worktree build minted — whose row it cannot
 * read — from an abandoned one. First mint wins: a retry or reuse never
 * re-attributes it.
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
  minter: Namespace,
  signal?: AbortSignal,
): Promise<WorktreeSetup> {
  const repoRoot = await ensureMainWorktreeRoot(signal);
  // Idempotent: an already-present worktree dir means the checkout already
  // landed, so a durable-job retry (or a caller reusing an existing worktree) is
  // a no-op. `worktreePathFor` derives the path purely from the id, so the dir's
  // existence is an authoritative "already set up" signal — except for a
  // checkout a crash cut short (an add or a spare's switch never finished),
  // which it converges.
  //
  // The lock is re-asserted rather than skipped: this is the path every reused
  // and every pre-lock worktree takes, so making it the place the lock is
  // guaranteed means a checkout cannot stay unlocked just because it predates
  // this code or something released its lock.
  if (await pathExists(wtPath)) {
    const { source } = await convergeExistingCheckout(
      repoRoot,
      id,
      wtPath,
      (fn) => withWorktreeMutateSlot(fn, signal),
      signal,
    );
    // Every path ends installed — this one too: it covers a checkout made
    // before checkouts installed themselves, and a retry whose install failed.
    // ~140 ms of freshness check when already installed. Not frozen: its
    // package.jsons are the agent's own edits (see installCheckout).
    const depStore = await installCheckout(
      repoRoot,
      wtPath,
      { frozen: false },
      signal,
    );
    await stampMinter(id, minter);
    return { source, depStore };
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
    await probeNamespace(repoRoot, ns, compositionIds),
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
  // Outside the gate: it serialises git mutations host-wide, and the install is
  // guarded by the checkout's own `.install.lock`. A claimed spare is already
  // installed, but its switch may have moved `bun.lock` (a frozen re-install);
  // a fresh add installs from scratch. Thrown, so the launch fails loudly with
  // install's own output.
  const depStore = await installCheckout(
    repoRoot,
    wtPath,
    { frozen: true },
    signal,
  );
  await stampMinter(id, minter);
  return { source, depStore };
}

// Once the checkout exists, never before: a stamp-only `<ns>/` dir with no
// checkout beside it reads as a registry orphan, and the sweep removes it.
async function stampMinter(id: string, minter: Namespace): Promise<void> {
  const checkout = asNamespace(id);
  if ((await readCheckoutMinter(checkout)).kind === "absent")
    await stampCheckoutMinter(checkout, minter);
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
 *
 * Answers what became of the checkout's dependency store (kept for the next
 * checkout, or deleted with it), for the caller's log; `absent` when there was
 * no dir to move (only the registration was dropped).
 */
export async function removeWorktree(
  wtPath: string,
  signal?: AbortSignal,
): Promise<WorktreeRemoval> {
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
    const registered = (await listWorktreeEntries(repoRoot, signal)).some(
      (e) => e.path === wtPath,
    );
    if (registered) await unlockWorktreeForRemoval(repoRoot, wtPath, signal);

    let moved = false;
    if (await pathExists(wtPath)) {
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
  if (!trashed) return { kind: "absent" };
  // Its dependency store goes to the next checkout instead of being deleted
  // while that one clones it again (dep-store-pool.ts). Outside the gate, like
  // the delete: a read-only walk of the store and a rename of it. Never throws.
  const depStore = await harvestDepStore(repoRoot, trashPath, Date.now());
  await deleteTrashEntry(trashPath);
  return { kind: "removed", depStore };
}

/** What `removeWorktree` did with the checkout's dir. */
export type WorktreeRemoval =
  { kind: "removed"; depStore: HarvestResult } | { kind: "absent" };
