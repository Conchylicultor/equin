import { fstatSync, mkdirSync, unlinkSync } from "node:fs";
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { rm } from "node:fs/promises";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import { basename, dirname, join, resolve } from "node:path";
import {
  MAIN_COMPOSITION_ID,
  namespaceFor,
} from "@plugins/infra/plugins/namespace/core";
import { GIT, worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import { flockRelease, flockTry } from "@plugins/packages/plugins/flock/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  addCheckout,
  withWorktreeMutateSlot,
} from "@plugins/infra/plugins/worktree/server";
import { findMiseBin } from "@plugins/toolchain/core";
import { releaseCheckoutsDir } from "../../data-dirs";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Bounds for every git child, mirroring `infra/worktree`'s values and for the
// same reason: the prune runs while one of the host-wide `worktree-mutate`
// slots is held, so an unbounded wedge there stalls worktree checkouts on every
// backend on the machine. Wedge-breakers, not latency police.
const PRUNE_TIMEOUT_MS = 60_000;
const REV_PARSE_TIMEOUT_MS = 60_000;
const MISE_TRUST_TIMEOUT_MS = 30_000;

/** A private checkout this process owns, and the one way to give it back. */
export interface ReleaseCheckout {
  /** The run id the checkout is named after (also its scratch namespace). */
  name: string;
  /** Absolute path of the checkout's root. */
  root: AppPath;
  /** What the sweep that opened this acquire did — the caller reports it. */
  swept: SweepResult;
  /**
   * Remove the checkout, its git registration and its scratch namespace data
   * dir, then release the lock. Idempotent: a second call is a no-op.
   */
  dispose(): Promise<void>;
}

/** What one sweep did, entry by entry. */
export interface SweepResult {
  /** Leaked checkouts (owner dead) that were removed. */
  removed: string[];
  /** Checkouts whose owner still holds the lock — left alone. */
  live: string[];
  /** Leaked checkouts whose removal failed; the next sweep retries them. */
  failed: { name: string; error: string }[];
}

/**
 * Whether `root` is a release checkout: a DIRECT child of the release-checkouts
 * dir. The release CLI asks this of its own root to tell the inner build (run
 * from inside a private checkout) from an invocation that must create one.
 *
 * Compared through `realpath` so a data root reached through a symlink (or
 * macOS's `/tmp` → `/private/tmp`) still matches.
 */
export function isReleaseCheckout(root: AppPath): boolean {
  const abs = resolve(root);
  if (basename(abs).endsWith(".lock")) return false;
  return (
    realOrSelf(asAppPath(dirname(abs))) === realOrSelf(releaseCheckoutsDir.path)
  );
}

/**
 * Create a detached checkout of `sha` named `name`, held by this process until
 * `dispose()` (or until it dies — the lock is a kernel flock, so the next
 * release's sweep reclaims a checkout whose owner was SIGKILLed).
 *
 * Starts with a sweep, so a leaked checkout costs only disk until the next
 * release. `name` must be unique (a release run id is) and a valid namespace
 * label: the checkout's basename becomes the scratch namespace the inner build
 * writes its artifacts under.
 */
export async function acquireReleaseCheckout(opts: {
  sourceRoot: AppPath;
  sha: string;
  name: string;
}): Promise<ReleaseCheckout> {
  const { sourceRoot, sha, name } = opts;
  const root = releaseCheckoutPath(name);

  const swept = await sweepLeakedReleaseCheckouts(sourceRoot);

  mkdirSync(releaseCheckoutsDir.path, { recursive: true });
  if (existsSync(root)) {
    throw new Error(
      `release checkout ${root} already exists — checkout names are run ids and must be unique`,
    );
  }
  const lockPath = lockPathFor(root);
  const lock = takeOwnLock(lockPath);

  try {
    // `infra/worktree`'s add: no `git worktree add`, which dies beside another
    // add half-way through writing its admin entry. It leaves no partial
    // checkout behind when it fails.
    await withWorktreeMutateSlot(() =>
      addCheckout(name, sourceRoot, root, { kind: "detached", rev: sha }),
    );
    await assertCheckoutAt(root, sha);
  } catch (err) {
    // Removes whatever the add left (its own cleanup ran for a timeout or a
    // failed exit; a failed assertion leaves a full checkout), then gives the
    // lock back. The ORIGINAL failure is what surfaces; a cleanup that fails
    // too is printed and left to the next release's sweep.
    try {
      await removeCheckoutArtifacts(sourceRoot, root);
      dropLock(lockPath, lock);
    } catch (cleanupErr) {
      flockRelease(lock.fd);
      lock.close();
      console.warn(
        `  Could not clean up the failed release checkout ${root} (the next release's sweep retries): ${String(cleanupErr)}`,
      );
    }
    throw err;
  }
  await trustMiseConfig(root);

  let disposed = false;
  return {
    name,
    root,
    swept,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await removeCheckoutArtifacts(sourceRoot, root);
      } catch (err) {
        // Keep the lock file (the sweep keys on it) but release the lock, so
        // the next release's sweep sees a leaked checkout and retries.
        flockRelease(lock.fd);
        lock.close();
        throw err;
      }
      dropLock(lockPath, lock);
    },
  };
}

/**
 * Remove every release checkout whose owner is gone — i.e. whose lock this
 * process can take. A checkout whose lock is held belongs to a running release
 * and is left alone. Per-entry failures are contained and reported, never
 * thrown: one stuck entry must not block every future release.
 */
export async function sweepLeakedReleaseCheckouts(
  repoRoot: string,
): Promise<SweepResult> {
  const result: SweepResult = { removed: [], live: [], failed: [] };
  const dir = releaseCheckoutsDir.path;
  if (!existsSync(dir)) return result;

  // An entry is a checkout dir, a lock file, or both. A lock file with no
  // checkout is an acquire that died between taking the lock and `worktree
  // add`, or a dispose that died after removing the tree.
  const names = new Set<string>();
  for (const entry of readdirSync(dir)) {
    names.add(
      entry.endsWith(".lock") ? entry.slice(0, -".lock".length) : entry,
    );
  }

  for (const name of [...names].sort()) {
    const root = joinAppPath(dir, name);
    const lockPath = lockPathFor(root);
    const lock = tryTakeLock(lockPath);
    if (lock === null) {
      result.live.push(name);
      continue;
    }
    try {
      await removeCheckoutArtifacts(repoRoot, root);
    } catch (err) {
      flockRelease(lock.fd);
      lock.close();
      result.failed.push({ name, error: String(err) });
      continue;
    }
    dropLock(lockPath, lock);
    result.removed.push(name);
  }
  return result;
}

// ── internals ────────────────────────────────────────────────────────────────

/** `<dir>/<name>`, refusing a name that is not a valid namespace label. */
export function releaseCheckoutPath(name: string): AppPath {
  // The scratch namespace IS the checkout's basename (a worktree checkout's
  // namespace for the main composition), so mint it here: this is the throw
  // for a name with a separator, a `..`, or anything else that is no label.
  namespaceFor(MAIN_COMPOSITION_ID, { kind: "worktree", name });
  return joinAppPath(releaseCheckoutsDir.path, name);
}

function lockPathFor(root: AppPath): AppPath {
  return asAppPath(`${root}.lock`);
}

function realOrSelf(path: AppPath): string {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw err;
  }
}

/**
 * Take the lock at `lockPath` without blocking, or return `null` when another
 * process holds it.
 *
 * The lock file is unlinked by whoever disposes of a checkout, WHILE holding
 * the lock. A second process could have opened the old file just before that
 * unlink and then win the flock on an inode no longer at the path — a lock
 * nobody else can see. So a won flock only counts if the path still names the
 * inode we locked; otherwise it is dropped and reported as not taken.
 */
function tryTakeLock(lockPath: AppPath): OwnedFd | null {
  // "a", never "w": opening must not truncate anything a holder wrote.
  const lock = openOwnedFd(lockPath, "a");
  if (!flockTry(lock.fd)) {
    lock.close();
    return null;
  }
  let onPath: number | null;
  try {
    onPath = statSync(lockPath).ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    onPath = null;
  }
  if (onPath !== fstatSync(lock.fd).ino) {
    flockRelease(lock.fd);
    lock.close();
    return null;
  }
  return lock;
}

/**
 * The owner's acquire. The name is unique, so the only way to lose is the
 * unlink race {@link tryTakeLock} describes (a sweep reclaiming this very lock
 * file in the instant between our open and our flock) — retried a few times,
 * then a loud failure.
 */
function takeOwnLock(lockPath: AppPath): OwnedFd {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = tryTakeLock(lockPath);
    if (lock !== null) return lock;
  }
  throw new Error(
    `could not take the release checkout lock ${lockPath}: another process holds it, ` +
      `but checkout names are run ids and must be unique`,
  );
}

/** Unlink the lock file (while still holding it), then release and close. */
function dropLock(lockPath: AppPath, lock: OwnedFd): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  flockRelease(lock.fd);
  lock.close();
}

/** The checkout really is at `sha` — the whole point of pinning. */
async function assertCheckoutAt(root: AppPath, sha: string): Promise<void> {
  const r = await spawnCaptured([GIT, "-C", root, "rev-parse", "HEAD"], {
    timeoutMs: REV_PARSE_TIMEOUT_MS,
  });
  const head = r.stdout.trim();
  if (r.timedOut || r.exitCode !== 0 || head !== sha) {
    throw new Error(
      `release checkout ${root} is not at ${sha} ` +
        `(rev-parse HEAD: ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}, ` +
        `"${head}", ${r.stderr.trim() || "<no stderr>"})`,
    );
  }
}

/**
 * Trust the checkout's `mise.toml`, so the `bun` / `go` shims the inner build
 * runs from inside it do not refuse an untrusted config. The machine-global
 * `trusted_config_paths` covers only `.claude/worktrees`.
 *
 * Best-effort: mise may not be installed at all (`findMiseBin` returns
 * `null`), and on a machine where it is not needed the inner build still
 * works. A trust that RAN and failed is printed, never swallowed — if the
 * build then fails on an untrusted config, the reason is on screen.
 */
async function trustMiseConfig(root: AppPath): Promise<void> {
  const bin = findMiseBin();
  if (bin === null) return;
  const r = await spawnCaptured([bin, "trust", join(root, "mise.toml")], {
    timeoutMs: MISE_TRUST_TIMEOUT_MS,
  });
  if (r.timedOut || r.exitCode !== 0) {
    console.warn(
      `  mise trust ${root}/mise.toml did not succeed ` +
        `(${r.timedOut ? "timed out" : `exit ${r.exitCode}`}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}

/** Throws unless `root` is a direct child of the release-checkouts dir. */
function assertReleaseCheckoutPath(root: AppPath): void {
  if (!isReleaseCheckout(root)) {
    throw new Error(
      `refusing to remove ${root}: not a direct child of ${releaseCheckoutsDir.path}`,
    );
  }
}

/**
 * Remove a checkout and everything it produced: the tree, its git
 * registration, and the scratch namespace's data dir (the inner build writes
 * its release web dist and check transcripts under
 * `worktrees/<name>/`). Holds no lock of its own — the caller must own the
 * checkout's lock.
 *
 * The path guard sits here, at the destructive call, not one frame above.
 */
export async function removeCheckoutArtifacts(
  repoRoot: string,
  root: AppPath,
): Promise<void> {
  assertReleaseCheckoutPath(root);
  const name = basename(root);

  // The tree, then the registration its absence leaves stale. Not `git worktree
  // remove` (nor a `git worktree list` to choose it): both enumerate every
  // worktree and die beside another add half-way through writing its admin
  // entry. A release checkout is never locked, so the prune drops it.
  await withWorktreeMutateSlot(async () => {
    await rm(root, { recursive: true, force: true });
    await pruneWorktrees(repoRoot, root);
  });

  await rm(
    worktreeDataDir(
      namespaceFor(MAIN_COMPOSITION_ID, { kind: "worktree", name }),
    ),
    { recursive: true, force: true },
  );
}

/**
 * Drop stale `.git/worktrees` entries. Logged rather than thrown: it runs after
 * the destructive step already succeeded, and a stale admin entry is harmless
 * until the next prune clears it.
 */
async function pruneWorktrees(repoRoot: string, root: string): Promise<void> {
  const r = await spawnCaptured([GIT, "-C", repoRoot, "worktree", "prune"], {
    tier: "background",
    timeoutMs: PRUNE_TIMEOUT_MS,
  });
  if (r.timedOut || r.exitCode !== 0) {
    console.warn(
      `  git worktree prune after removing ${root} did not succeed ` +
        `(${r.timedOut ? "timed out" : `exit ${r.exitCode}`}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}
