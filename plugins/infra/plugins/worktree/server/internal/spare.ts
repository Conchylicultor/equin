import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { installCheckout } from "./install-checkout";
import { withWorktreeMutateSlot } from "./mutate-gate";
import { isSpareName, newSpareName, SPARE_LOCK_REASON } from "./spare-name";
import {
  addCheckout,
  ensureMainWorktreeRoot,
  gitWorktreesDir,
  listReadySpares,
  listWorktreeEntries,
  lockWorktree,
  removeWorktree,
} from "./worktree";

// The spare pool's mechanics. `infra/worktree` stays job-free (the CLI imports
// it); the refill job, its boot warm-up and its daily cron live in the
// `spare-pool` sub-plugin, which calls these.

/**
 * A spare that is not READY (unregistered, or unlocked) is a refill killed
 * mid-add or a claim killed between its `unlock` and its `move`. Either one
 * finishes in seconds, so anything not ready for this long is debris. Measured
 * from the newest of the checkout dir's and its admin dir's mtime — an `unlock`
 * rewrites the admin dir, so an old spare a claim just unlocked reads as fresh.
 */
const SPARE_DEBRIS_AGE_MS = 15 * 60_000;

/**
 * A READY spare older than this is replaced, so the daily refill keeps one from
 * drifting for weeks behind `main` (a claim's switch costs the diff since).
 */
const SPARE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Write one spare: a detached checkout of `main` at
 * `.claude/worktrees/spare-<ms>-<rand>`, `install` it, then lock it with
 * `SPARE_LOCK_REASON` — the readiness marker, so it is claimable only once fully
 * written AND installed. Shares `addCheckout` (one `checkout.workers=0`, one
 * timeout, one partial-tree cleanup) with the cold path. Call inside a
 * mutate-gate hold.
 *
 * @param install `installCheckout` in production; required so no caller can
 * make a ready spare that is not installed. Tests pass their own.
 */
export async function createSpareIn(
  repoRoot: string,
  install: (path: string, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  const path = join(gitWorktreesDir(repoRoot), newSpareName());
  await addCheckout(
    basename(path),
    repoRoot,
    path,
    ["--detach", path, "main"],
    signal,
  );
  // Before the lock, so ready == installed. A failed install throws and leaves
  // an unlocked spare: not ready, and the prune reclaims it.
  await install(path, signal);
  // Thrown, unlike an agent checkout's lock: an unlocked spare is not ready,
  // and the prune reclaims it.
  const r = await lockWorktree(repoRoot, path, SPARE_LOCK_REASON, signal);
  if (r.exitCode !== 0) {
    throw new Error(
      `could not lock spare ${path} ` +
        `(${r.timedOut ? "timed out" : `exit ${r.exitCode}`}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
  return path;
}

/** Write one ready spare under the host-wide `worktree-mutate` gate. */
export async function createSpareWorktree(
  signal?: AbortSignal,
): Promise<string> {
  const repoRoot = await ensureMainWorktreeRoot(signal);
  return withWorktreeMutateSlot(
    () =>
      createSpareIn(
        repoRoot,
        (path, sig) => installCheckout(path, { frozen: true }, sig),
        signal,
      ),
    signal,
  );
}

// The mtime of the spare's admin dir (`.git/worktrees/spare-…`), read through
// its `.git` pointer file; null when there is none.
async function adminDirMtime(path: string): Promise<number | null> {
  let gitFile: string;
  try {
    gitFile = await readFile(join(path, ".git"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const gitdir = /^gitdir: (.+)$/m.exec(gitFile)?.[1]?.trim();
  if (!gitdir || !existsSync(gitdir)) return null;
  return (await stat(gitdir)).mtimeMs;
}

/**
 * The spares in `repoRoot` to reclaim at `now`: `spare-*` dirs that are not
 * ready (unregistered, or registered and unlocked) and older than
 * `SPARE_DEBRIS_AGE_MS`, plus ready ones older than `SPARE_MAX_AGE_MS`. A spare
 * locked with any OTHER reason is not ours to judge and is left alone.
 *
 * An old READY spare is taken the way a claim takes one — by `unlock`, which a
 * concurrent claimer can win — so the prune never removes a spare mid-claim.
 */
export async function pruneSparesIn(
  repoRoot: string,
  now: number,
  remove: (path: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string[]> {
  const dir = gitWorktreesDir(repoRoot);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter(isSpareName);
  if (names.length === 0) return [];
  const entries = new Map(
    (await listWorktreeEntries(repoRoot, signal)).map((e) => [e.path, e]),
  );
  const removed: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const entry = entries.get(path);
    if (entry?.locked === SPARE_LOCK_REASON) {
      const createdAt = Number(name.split("-")[1]);
      if (!(now - createdAt > SPARE_MAX_AGE_MS)) continue;
      const unlocked = await spawnCaptured(
        [GIT, "-C", repoRoot, "worktree", "unlock", path],
        { timeoutMs: 60_000, signal },
      );
      // A claimer unlocked it first: it is theirs now.
      if (unlocked.timedOut || unlocked.exitCode !== 0) continue;
    } else if (entry?.locked != null) {
      continue;
    } else {
      const mtimes = [(await stat(path)).mtimeMs];
      const admin = await adminDirMtime(path);
      if (admin !== null) mtimes.push(admin);
      if (!(now - Math.max(...mtimes) > SPARE_DEBRIS_AGE_MS)) continue;
    }
    await remove(path);
    removed.push(path);
  }
  return removed;
}

/**
 * Reclaim spare debris and over-age spares (see `pruneSparesIn`) through
 * `removeWorktree`, which takes the mutate gate per removal.
 */
export async function pruneSpares(signal?: AbortSignal): Promise<string[]> {
  const repoRoot = await ensureMainWorktreeRoot(signal);
  return pruneSparesIn(
    repoRoot,
    Date.now(),
    (path) => removeWorktree(path, signal),
    signal,
  );
}

/** How many spares are ready to claim right now. */
export async function countReadySpares(signal?: AbortSignal): Promise<number> {
  const repoRoot = await ensureMainWorktreeRoot(signal);
  return (await listReadySpares(repoRoot, signal)).length;
}
