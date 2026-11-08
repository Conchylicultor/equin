import { renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import {
  openOwnedFdSync,
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
  opts?: { stdin?: string; privateIndexWrites?: true },
): Promise<{ code: number; stdout: string }> {
  // Never the caller's GIT_INDEX_FILE (a hook's, say): the index this hashes
  // from and publishes to is the checkout's own, or the scratch one we pass.
  const { GIT_INDEX_FILE: _ignored, ...inherited } = process.env;
  const result = await spawnCaptured(["git", ...args], {
    cwd: root,
    env: env ?? inherited,
    timeoutMs: TREE_HASH_TIMEOUT_MS,
    ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
    ...(opts?.privateIndexWrites ? { privateIndexWrites: true } : {}),
  });
  return { code: result.exitCode, stdout: result.stdout.trim() };
}

// git's untracked cache, asked for on the calls that walk the worktree rather
// than left to the repo's config: a clone that never ran a build has it unset,
// and without it every `status` reads every directory of the tree.
const WITH_UNTRACKED_CACHE = ["-c", "core.untrackedCache=true"];

/**
 * What `git add -A` would change in the index `env` names, as pathspecs: every
 * tracked path whose worktree differs (modified, deleted, type-changed, a
 * conflicted one) and every untracked entry — a file, or a wholly untracked
 * directory (`dir/`) that the add then walks. Asked of `git status`, which
 * walks only the directories its untracked cache cannot vouch for, and which —
 * run with writes allowed on this PRIVATE index — saves its refreshed stats and
 * that cache into it. Null when status fails: the caller falls back to a plain
 * `add -A`.
 */
async function pendingPaths(
  root: AppPath,
  env: Record<string, string | undefined>,
): Promise<string[] | null> {
  const status = await spawnCaptured(
    [
      "git",
      ...WITH_UNTRACKED_CACHE,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=normal",
      "--no-renames",
      "--ignore-submodules=none",
    ],
    {
      cwd: root,
      env,
      timeoutMs: TREE_HASH_TIMEOUT_MS,
      privateIndexWrites: true,
    },
  );
  if (status.exitCode !== 0) return null;
  const paths: string[] = [];
  for (const record of status.stdout.split("\0")) {
    if (record.length === 0) continue;
    const kind = record[0];
    if (kind === "?") paths.push(record.slice(2));
    // `1 XY sub mH mI mW hH hI path`, `u XY sub m1 m2 m3 mW h1 h2 h3 path`.
    else if (kind === "1") paths.push(fieldsTail(record, 8));
    else if (kind === "u") paths.push(fieldsTail(record, 10));
    // `2` cannot appear under --no-renames, `!` without --ignored.
    else return null;
  }
  return paths;
}

/** The rest of a porcelain record after its first `n` space-separated fields. */
function fieldsTail(record: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) {
    at = record.indexOf(" ", at) + 1;
    if (at === 0) throw new Error(`git status: short record ${record}`);
  }
  return record.slice(at);
}

/**
 * Content hash of the full working tree (tracked + working changes, honoring
 * .gitignore) WITHOUT changing what the user's real index stages: the tree
 * `git add -A` + `write-tree` would write, on a throwaway index seeded from
 * the real one. Commit-message amends do NOT change this hash (write-tree is
 * content-only), so a `push` after an unchanged `build` produces the same hash.
 *
 * Cost follows what changed, not the tree:
 * - `git status` on the scratch index names what `add -A` would change. Its
 *   refresh re-reads only the files the stat cache cannot vouch for, and its
 *   untracked listing reads only the directories git's untracked cache cannot
 *   (every other one is a stat).
 * - What status learns (refreshed stats, the untracked cache) is published to
 *   the real index (`publishRefreshedIndex`), so neither this walk nor any
 *   later git read in the checkout pays for it again: the build's own
 *   `git status` (`loadRepoSnapshot`) is the main beneficiary.
 * - `add -A` is limited to the paths status named (none: no add at all), so
 *   it walks only those. Its own walk never consults the untracked cache.
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
    // stat cache to inherit, and a plain `add -A` into the empty scratch index
    // below hashes the same tree: what is on disk, honoring .gitignore.
    // (Seeding from `HEAD` instead gave nothing — a tree read carries no stat
    // info — and failed outright on an unborn branch.)
    let pending: string[] | null = null;
    if (existsSync(realIndex)) {
      const seen = statSync(realIndex, { bigint: true });
      const seed = readFileSync(realIndex);
      copyIndex(seed, seen, tmpIndex);
      pending = await pendingPaths(root, env);
      const learnedSomething =
        !readFileSync(tmpIndex).equals(seed) ||
        hasRacyEntry(seed, seen.mtimeMs / 1000n, hashBytes);
      if (learnedSomething) {
        // Status learned something: a stat-dirty entry re-stamped (the bytes
        // changed), racily clean ones confirmed by content — which changes no
        // byte, only the index's own mtime, now strictly newer than them — or
        // directories it listed into the untracked cache. Hand it to the real
        // index, so neither this walk nor any later git read pays for it
        // again; hash on a copy. Status never stages: the published index
        // differs from the real one in caches only.
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

    if (pending === null) {
      if ((await git(root, ["add", "-A"], env)).code !== 0) return null;
    } else if (pending.length > 0) {
      // Literal pathspecs: a path is a name, never a pattern. A path gone
      // between status and here fails the add ("did not match"): the plain
      // `add -A` then answers for the tree as it is now.
      const scoped = await git(
        root,
        [
          "--literal-pathspecs",
          "add",
          "-A",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        env,
        { stdin: pending.join("\0") },
      );
      if (scoped.code !== 0 && (await git(root, ["add", "-A"], env)).code !== 0)
        return null;
    }
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

/**
 * The repo's MAIN checkout — the one whose `.git` is the common dir every linked
 * worktree shares — or null when git cannot say. `root` itself when `root` is
 * the main checkout. Fail-open like `computeTreeHash`: a null only narrows the
 * read-set candidates a run tries to its own.
 */
export async function mainCheckoutRoot(root: AppPath): Promise<AppPath | null> {
  const { code, stdout } = await git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (code !== 0 || !stdout.startsWith("/")) return null;
  return appPathParent(asAppPath(stdout));
}

/** One blob a pathspec names in a tree. */
export interface TreePathspecEntry {
  path: string;
  blob: string;
}

/**
 * Every (path, blob) of `tree` that `pathspecs` name, in index order, by git's
 * OWN pathspec matcher — the set `git grep <tree> -- <pathspecs>` searches —
 * without reading a file: `read-tree` into a scratch index beside this
 * checkout's real one, then `ls-files -s` over it. The scratch index is removed
 * before returning; one left by a killed run is swept by `computeTreeHash`.
 * Throws on any git failure: a domain that did not load must not read as empty.
 */
export async function listTreePathspec(
  root: AppPath,
  tree: string,
  pathspecs: readonly string[],
): Promise<TreePathspecEntry[]> {
  const indexPath = (
    await git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])
  ).stdout;
  if (!indexPath.startsWith("/"))
    throw new Error(`listTreePathspec: no index path for ${root}`);
  const nonce = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const scratch = besideIndex(
    asAppPath(indexPath),
    `equin-tree-domain-${nonce}`,
  );
  try {
    const { GIT_INDEX_FILE: _ignored, ...inherited } = process.env;
    const env = { ...inherited, GIT_INDEX_FILE: scratch };
    const read = await git(root, ["read-tree", tree], env);
    if (read.code !== 0)
      throw new Error(
        `listTreePathspec: git read-tree ${tree} failed (exit ${read.code})`,
      );
    const listed = await git(
      root,
      ["ls-files", "-s", "-z", "--", ...pathspecs],
      env,
    );
    if (listed.code !== 0)
      throw new Error(
        `listTreePathspec: git ls-files failed (exit ${listed.code})`,
      );
    const entries: TreePathspecEntry[] = [];
    for (const record of listed.stdout.split("\0")) {
      if (record === "") continue;
      // `<mode> <blob> <stage>\t<path>`; a gitlink (160000) has no bytes to grep.
      const tab = record.indexOf("\t");
      const [mode, blob] = record.slice(0, tab).split(" ");
      if (mode === "160000" || blob === undefined) continue;
      entries.push({ path: record.slice(tab + 1), blob });
    }
    return entries;
  } finally {
    rmSync(scratch, { force: true });
  }
}

/** `<index>.<suffix>`, in the index's own directory (git's lock spelling). */
function besideIndex(index: AppPath, suffix: string): AppPath {
  const name = index.slice(index.lastIndexOf("/") + 1);
  return joinAppPath(appPathParent(index), `${name}.${suffix}`);
}

// What follows `<index>.equin-` in a scratch index's name (see `nonce`).
const SCRATCH_SUFFIX = /^(?:tree-hash|refreshed|tree-domain)-(\d+)-[0-9a-f]+$/;

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
    fd = openOwnedFdSync(lock, "wx");
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
