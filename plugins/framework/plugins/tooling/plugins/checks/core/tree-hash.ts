import { renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { randomBytes } from "crypto";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  type AppPath,
  appPathParent,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Looser than the metadata-read bound used elsewhere in the check tree,
// because `add -A` + `write-tree` below genuinely walk the whole working tree:
// this is real work, and it is done on every build and every check run, on a
// box that may be running several agent fleets at once. Three minutes is a
// wedge-breaker for it, not a latency budget.
const TREE_HASH_TIMEOUT_MS = 180_000;

async function git(
  root: AppPath,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
  // Never the caller's GIT_INDEX_FILE (a hook's, say): the index this hashes
  // from and publishes to is the checkout's own, or the scratch one we pass.
  const { GIT_INDEX_FILE: _ignored, ...inherited } = process.env;
  const result = await spawnCaptured(["git", ...args], {
    cwd: root,
    env: env ?? inherited,
    timeoutMs: TREE_HASH_TIMEOUT_MS,
  });
  return { code: result.exitCode, stdout: result.stdout.trim() };
}

/**
 * Content hash of the full working tree (tracked + working changes, honoring
 * .gitignore) WITHOUT changing what the user's real index stages. Uses a
 * throwaway index seeded from the real one (for its stat cache), then `add -A`
 * + `write-tree`. Commit-message amends do NOT change this hash (write-tree is
 * content-only), so a `push` after an unchanged `build` produces the same hash.
 *
 * Cost is O(entries the real index cannot vouch for by stat) — files changed
 * since it was written, plus its racily clean ones — never O(tree content),
 * because what the refresh learns is published back (`publishRefreshedIndex`).
 *
 * Fail-open: returns null if git is unavailable or any step fails — callers
 * then run uncached. The cache must never block or break a check run.
 */
export async function computeTreeHash(root: AppPath): Promise<string | null> {
  const scratch: AppPath[] = [];
  try {
    // ABSOLUTE, always: `--git-path` alone answers relative in the main
    // checkout (`.git/index`) but absolute in a linked worktree, and joining
    // that onto `root` named no file — so every agent worktree seeded nothing
    // and `add -A` re-hashed the content of the whole tree on every run. The
    // scratch indexes sit beside it, so a refreshed one can be renamed into
    // place.
    const [indexPath, objectFormat] = (
      await git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
        "--show-object-format",
      ])
    ).stdout.split("\n");
    if (!indexPath?.startsWith("/")) return null;
    // This checkout's own index: the one path this module claims.
    const realIndex = asAppPath(indexPath);
    const hashBytes = objectFormat === "sha256" ? 32 : 20;
    const nonce = `${process.pid}-${randomBytes(4).toString("hex")}`;
    const tmpIndex = besideIndex(realIndex, `equin-tree-hash-${nonce}`);
    scratch.push(tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    sweepDeadScratch(realIndex);

    // With no index yet (a fresh `git init`, nothing ever added) there is no
    // stat cache to inherit, and `add -A` into the empty scratch index below
    // hashes the same tree: what is on disk, honoring .gitignore. (Seeding
    // from `HEAD` instead gave nothing — a tree read carries no stat info — and
    // failed outright on an unborn branch.)
    if (existsSync(realIndex)) {
      const seen = statSync(realIndex, { bigint: true });
      const seed = readFileSync(realIndex);
      copyIndex(seed, seen, tmpIndex);
      // Errors are benign: `add -A` below re-checks whatever is still dirty.
      await git(root, ["update-index", "-q", "--refresh"], env);
      const learnedSomething =
        !readFileSync(tmpIndex).equals(seed) ||
        hasRacyEntry(seed, seen.mtimeMs / 1000n, hashBytes);
      if (learnedSomething) {
        // The refresh learned something: a stat-dirty entry re-stamped (the
        // bytes changed), or racily clean ones confirmed by content — which
        // changes no byte, only the index's own mtime, now strictly newer than
        // them. Hand it to the real index, so neither this walk nor any later
        // git read pays for it again; hash on a copy.
        const learned = besideIndex(realIndex, `equin-refreshed-${nonce}`);
        scratch.push(learned);
        copyIndex(
          readFileSync(tmpIndex),
          statSync(tmpIndex, { bigint: true }),
          learned,
        );
        publishRefreshedIndex(realIndex, learned, seen);
      }
    }

    if ((await git(root, ["add", "-A"], env)).code !== 0) return null;
    const wt = await git(root, ["write-tree"], env);
    if (wt.code !== 0) return null;
    return /^[0-9a-f]{40,64}$/.test(wt.stdout) ? wt.stdout : null;
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- explicit fail-open contract: any error (no git, spawn failure, permissions) safely returns null so checks still run uncached; propagating would break every check in non-git environments
  } catch {
    // Any failure (not a git repo, spawn error, etc.) → degrade to uncached.
    return null;
  } finally {
    // force:true suppresses ENOENT (a published one was renamed away).
    for (const path of scratch) rmSync(path, { force: true });
  }
}

/** `<index>.<suffix>`, in the index's own directory (git's lock spelling). */
function besideIndex(index: AppPath, suffix: string): AppPath {
  const name = index.slice(index.lastIndexOf("/") + 1);
  return joinAppPath(appPathParent(index), `${name}.${suffix}`);
}

// What follows `<index>.equin-` in a scratch index's name (see `nonce`).
const SCRATCH_SUFFIX = /^(?:tree-hash|refreshed)-(\d+)-[0-9a-f]+$/;

/**
 * Remove the scratch indexes of runs that died before their `finally` (a
 * SIGKILL, a timeout kill): each is a copy of the whole index, named with its
 * writer's pid, so one whose pid no longer runs is debris. One listing of the
 * index's own (small) directory.
 */
function sweepDeadScratch(realIndex: AppPath): void {
  const dir = appPathParent(realIndex);
  const name = realIndex.slice(realIndex.lastIndexOf("/") + 1);
  const prefix = `${name}.equin-`;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix)) continue;
    const pid = SCRATCH_SUFFIX.exec(entry.slice(prefix.length))?.[1];
    if (pid === undefined || isAlive(Number(pid))) continue;
    rmSync(joinAppPath(dir, entry), { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it runs, as another user.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Whether git must re-check some entry by content: its mtime second is not
 * strictly older than the index file's (`indexSec`). Reads index format v2/v3
 * (what git writes unless `index.version` asks for 4, which this repo does
 * not); any other version answers true, so the caller just publishes.
 */
function hasRacyEntry(
  index: Buffer,
  indexSec: bigint,
  hashBytes: number,
): boolean {
  if (index.length < 12 || index.toString("latin1", 0, 4) !== "DIRC")
    return true;
  const version = index.readUInt32BE(4);
  if (version !== 2 && version !== 3) return true;
  const count = index.readUInt32BE(8);
  // ctime(8) mtime(8) dev ino mode uid gid size (6×4), hash, flags(2).
  const fixed = 40 + hashBytes + 2;
  let at = 12;
  for (let i = 0; i < count; i++) {
    if (at + fixed > index.length) return true;
    if (BigInt(index.readUInt32BE(at + 8)) >= indexSec) return true;
    const flags = index.readUInt16BE(at + fixed - 2);
    const extended = (flags & 0x4000) !== 0 ? 2 : 0;
    const nameStart = at + fixed + extended;
    const nul = index.indexOf(0, nameStart);
    if (nul < 0) return true;
    // Each entry is NUL-padded to a multiple of 8 bytes, at least one NUL.
    at += (fixed + extended + (nul - nameStart) + 8) & ~7;
  }
  return false;
}

/**
 * Write an index's bytes to `dst` WITH the source's mtime. Load-bearing for
 * correctness, not tidiness: git re-checks by content every entry whose file
 * is not strictly older (in whole seconds — Apple git has no USE_NSEC) than
 * the index file, which is how a file edited in the same second as the index
 * was written is still caught. A fresh mtime would make those entries trusted
 * by stat and hash a stale tree — a false check-cache hit.
 */
function copyIndex(
  bytes: Buffer,
  st: { atimeMs: bigint; mtimeMs: bigint },
  dst: AppPath,
): void {
  writeFileSync(dst, bytes, { flag: "wx" });
  utimesSync(dst, Number(st.atimeMs) / 1000, Number(st.mtimeMs) / 1000);
}

/**
 * Replace the real index with the refreshed one, compare-and-swap: only while
 * nobody has written it since it was read (`seen`), and only under git's own
 * `index.lock`, taken `wx` the way every git writer takes it — if one holds
 * it, this run just does not publish.
 *
 * Why publish at all: every child we spawn runs with `GIT_OPTIONAL_LOCKS=0`
 * (spawn's child-env), so no git READ ever saves the stat cache it refreshes.
 * Whatever left the real index unable to vouch for its files — a whole-tree
 * checkout (11,200 of 20,664 entries racily clean after a 2 s `worktree add`),
 * a spare claim's `switch`, a rebase, a codegen rewrite — stayed that way
 * until the next commit, and every tree hash re-read those files' content.
 *
 * Why this cannot reintroduce the collision child-env exists for (a push's
 * `merge` in main failing on "index.lock: File exists" beside `git status`):
 * the lock is held for one stat + one rename, synchronously — no await, no
 * child — not for the seconds a refresh takes, and only on runs that learned
 * something. The refreshed index differs from the real one in stat data only
 * (`update-index --refresh` never stages), and it carries the mtime git wrote
 * it with, so racy-git protection holds for it as for any index git writes.
 */
function publishRefreshedIndex(
  realIndex: AppPath,
  refreshed: AppPath,
  seen: { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): void {
  const lock = besideIndex(realIndex, "lock");
  let fd: OwnedFd;
  try {
    fd = openOwnedFd(lock, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return; // a writer has it
    throw err;
  }
  try {
    const now = statSync(realIndex, { bigint: true });
    const unchanged =
      now.ino === seen.ino &&
      now.size === seen.size &&
      now.mtimeNs === seen.mtimeNs &&
      now.ctimeNs === seen.ctimeNs;
    if (unchanged) renameSync(refreshed, realIndex);
  } finally {
    fd.close();
    unlinkSync(lock);
  }
}
