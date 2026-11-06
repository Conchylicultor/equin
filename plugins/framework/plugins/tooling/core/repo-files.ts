// The repo's file set, as a `RepoFiles` — ONE implementation for everything that
// is not reading a check run's tree snapshot: build-time codegen, the check
// runner's fallback (`--no-cache`, or a snapshot that failed to load), and
// `listRepoFiles`.
//
// The set comes from git, never from a filesystem walk. Everything in the check
// system that reasons about files derives them from git: the cache key
// (`computeTreeHash` — scratch index + `git add -A` + `write-tree`) and the
// read-set snapshot (one `git ls-tree -r` over that tree). A walk with its own
// deny-list answers a different question — it sees gitignored files the key
// does not cover — and so records a verdict that is not a function of its own
// key. That is what made a stray `.ts` under `.cache/scratch/` fail
// type-check's coverage gate (2026-09-09); see
// research/2026-09-09-tooling-check-file-enumeration-from-git.md.
//
// Membership (`all`, `has`, `under`) is answered in memory, and content through
// async reads one gate per set bounds — so a caller iterating thousands of
// files never makes a blocking call per file on a thread others share.

import { lstat, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { globPaths, pathsUnder } from "./pathspec";
import type { RepoFiles, RepoSnapshot } from "./types";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Wedge-breaker for a metadata-only git read, not a latency budget: what these
// suffer under a saturated check run is starvation, not slowness. Same bound
// and same reasoning as the check runner's read-set GIT_TIMEOUT_MS.
const GIT_TIMEOUT_MS = 60_000;

// How many `read()`s one set holds open at once, by default. A check run has
// ONE set, shared by every check, so this is the run's bound, not a check's: a
// caller that hands `read` seven thousand paths at once opens this many and
// queues the rest. Wide enough that one such caller does not park another's
// single read behind it for long. A process whose fs pool also serves requests
// (a backend) asks for a narrower set (`readConcurrency`), so its bulk reads
// leave the pool room for them.
const READ_CONCURRENCY = 64;

export interface RepoFilesOptions {
  /** How many `read()`s the set holds open at once (default 64). */
  readConcurrency?: number;
}

async function git(
  root: string,
  args: string[],
  stdin?: string,
): Promise<string> {
  const result = await spawnCaptured(["git", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (result.exitCode !== 0) {
    // Loud, never `[]`. An absorbed failure here would tell every caller the
    // repo is empty, turning each file rule into a vacuous PASS.
    throw new Error(
      `git ${args.join(" ")} failed in ${root} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function lsFiles(
  root: string,
  args: string[],
  literalPathspecs = false,
): Promise<string[]> {
  const out = await git(root, [
    ...(literalPathspecs ? ["--literal-pathspecs"] : []),
    "ls-files",
    "-z",
    ...args,
  ]);
  return out.split("\0").filter((p) => p.length > 0);
}

/**
 * Throws unless `path` is spelled the way a `RepoFiles` spells its members:
 * repo-relative, `/`-separated, no empty, `.` or `..` segment — so no leading
 * `/` or `./` and no trailing `/`. Spelled any other way it would match nothing
 * and read as "not in the set": `under("plugins/")` would hand the caller an
 * empty repo, and a check would pass. Every `RepoFiles` implementation calls
 * this on every path argument; `allowRoot` admits `""` (the whole repo) where
 * a directory is expected.
 */
export function assertRepoPath(
  method: string,
  path: string,
  allowRoot: boolean,
): void {
  if (path === "" && allowRoot) return;
  if (path.split("/").every((s) => s !== "" && s !== "." && s !== "..")) return;
  throw new Error(
    `RepoFiles.${method}(${JSON.stringify(path)}): expected a repo-relative ` +
      `path with no leading "/" or "./", no trailing "/" and no "." or ".." ` +
      `segment${allowRoot ? ' ("" is the whole repo)' : ""}.`,
  );
}

async function readWorkingTree(
  root: AppPath,
  path: string,
): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (err) {
    // In the set but gone from disk: removed after the set was taken. That is
    // "vanished", which `read` answers with null by contract. Any other error
    // is a real failure and stays one.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The working-tree text of a repo-relative path, read through one gate of
 * `readConcurrency` (default 64) — null when the file is gone. `RepoFiles.read`
 * minus the membership test, for a holder that tracks membership itself (a
 * `listRepoMembers` caller).
 */
export function repoFileReader(
  root: AppPath,
  opts?: RepoFilesOptions,
): (path: string) => Promise<string | null> {
  const gate = createSemaphore(opts?.readConcurrency ?? READ_CONCURRENCY);
  return (path) => {
    assertRepoPath("read", path, false);
    return gate.run(() => readWorkingTree(root, path));
  };
}

/**
 * A `RepoFiles` over `sorted` — every file path, repo-relative, in
 * `Array.prototype.sort()` order. Takes ownership of the array and freezes it,
 * so `all()` can hand it out uncopied. Content is read from the working tree
 * under `root`. For a caller that already holds the listing; everyone else
 * calls `loadRepoFiles`.
 */
export function repoFilesOver(
  root: AppPath,
  sorted: readonly string[],
  opts?: RepoFilesOptions,
): RepoFiles {
  const paths = Object.freeze(sorted);
  const members = new Set(paths);
  const readMember = repoFileReader(root, opts);
  return {
    root,
    all: () => paths,
    has: (path) => {
      assertRepoPath("has", path, false);
      return members.has(path);
    },
    under: (dir) => {
      assertRepoPath("under", dir, true);
      return pathsUnder(paths, dir);
    },
    glob: (pattern) => globPaths(paths, pattern),
    read: async (path) => {
      assertRepoPath("read", path, false);
      if (!members.has(path)) return null;
      return readMember(path);
    },
  };
}

/**
 * The repo's file set, asked of git: tracked + untracked-not-ignored, minus
 * index entries whose file is gone from the worktree. EXACTLY the membership
 * `computeTreeHash` folds into the check cache key, so a check that enumerates
 * through this can never record a verdict about content its key does not cover.
 *
 * The `--deleted` subtraction is load-bearing, not defensive: `--cached` lists
 * index entries, so a file removed from the worktree but not yet staged is
 * still listed — while `add -A` drops it from the cache key's tree and it is
 * absent from disk. Left in, it would reach predicates that go on to read it
 * (and, for type-check, a coverage gate built from tsconfig file names read off
 * disk, which cannot own a file that is not there) — a fresh false failure on a
 * file the user just deleted.
 *
 * A snapshot of the moment it is called: take it once per pass and hand the
 * value around, rather than memoizing it behind a module (a build writes files
 * mid-process). Inside a check, use `ctx.repo()` — the run's one set.
 *
 * Throws on any git failure — never an empty set.
 */
export async function loadRepoFiles(
  root: AppPath,
  opts?: RepoFilesOptions,
): Promise<RepoFiles> {
  return repoFilesOver(root, await listAllRepoMembers(root), opts);
}

/**
 * `loadRepoFiles`' membership — every member of the repo's file set, sorted —
 * at a cost that follows what changed, not the size of the tree.
 *
 * The expensive half of the set is what the index does not hold: the untracked
 * files, and the tracked ones gone from disk. `ls-files --others` answers the
 * first by walking every directory of the worktree (it never consults git's
 * untracked cache; ~0.9 s here quiet, seconds under load) and `ls-files
 * --deleted` the second by one serial lstat per index entry. One `git status`
 * answers both: its index refresh stats in parallel against the stat cache,
 * and its untracked listing (`-unormal`) reads `core.untrackedCache` — set by
 * every build — so only the directories that changed since the cache was
 * written are read again. `-unormal` names a wholly-untracked directory once
 * (`dir/`), so only those directories are walked, by one `ls-files --others`
 * scoped to them: the walk is the size of what is new.
 *
 * Membership is `git add -A`'s, as the check cache key's: an assume-unchanged
 * entry deleted from disk stays a member (status, like `add -A`, takes git's
 * word for it), where `ls-files --deleted` would have dropped it.
 *
 * `--no-optional-locks`: a reader never takes the worktree's index.lock (an
 * agent's own `git add` would fail on it). So this never writes the cache back
 * either; the cache stays as fresh as the last index write in the worktree (an
 * agent's `git status` / `add` / `commit`, a build), and the directories that
 * changed since are read again — still O(changes).
 *
 * Throws on any git failure — never an empty set.
 */
export async function listAllRepoMembers(root: AppPath): Promise<string[]> {
  const [cached, delta] = await Promise.all([
    lsFiles(root, ["--cached"]),
    worktreeDelta(root),
  ]);
  return membership([...cached, ...delta.untracked], delta.deleted);
}

/** What the working tree holds that the index does not say. */
interface WorktreeDelta {
  /** Untracked, not-ignored files (a nested repository: its `dir/`). */
  untracked: string[];
  /** Index entries whose file is gone from the worktree. */
  deleted: string[];
}

/**
 * `ls-files --others --exclude-standard` and `ls-files --deleted` over the
 * whole tree, asked of `git status` (see `listAllRepoMembers` for why). Never
 * pathspec-scoped: git consults the untracked cache only for a whole-tree
 * listing — scoped to `plugins/`, status walks it all again (~0.8 s vs ~0.1 s).
 */
async function worktreeDelta(root: AppPath): Promise<WorktreeDelta> {
  const out = await git(root, [
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=normal",
    "--no-renames",
    // As ls-files: a removed submodule is gone whatever its `ignore` config.
    "--ignore-submodules=none",
  ]);
  const files: string[] = [];
  const dirs: string[] = [];
  const deleted: string[] = [];
  const unmerged: string[] = [];
  for (const record of out.split("\0")) {
    if (record.length === 0) continue;
    const kind = record[0];
    if (kind === "?") {
      const path = record.slice(2);
      (path.endsWith("/") ? dirs : files).push(path);
    } else if (kind === "1") {
      // `1 XY sub mH mI mW hH hI path`: Y is the worktree against the index.
      if (record[3] === "D") deleted.push(fieldsTail(record, 8));
    } else if (kind === "u") {
      // `u XY sub m1 m2 m3 mW h1 h2 h3 path`: XY names the conflict, not the
      // worktree — asked of ls-files below, which lists a gone one per stage.
      unmerged.push(fieldsTail(record, 10));
    } else {
      // `2` (a rename) cannot appear under --no-renames, `!` without
      // --ignored: anything else is a format this parser does not know.
      throw new Error(
        `git status --porcelain=v2 in ${root}: unexpected record ${JSON.stringify(record)}`,
      );
    }
  }
  // A tracked file now a directory is "deleted" to status, which then names
  // nothing under it — while its files are untracked members (`add -A` swaps
  // the file for them). Walk those folders too: one lstat per deleted path.
  const replaced = await directoriesAmong(root, deleted);
  const [expanded, unmergedGone] = await Promise.all([
    lsFilesChunked(
      root,
      ["--others", "--exclude-standard"],
      [...dirs, ...replaced],
    ),
    lsFilesChunked(root, ["--deleted"], unmerged),
  ]);
  return {
    untracked: [...files, ...expanded],
    deleted: [...deleted, ...unmergedGone],
  };
}

/** Those of `paths` (repo-relative) that are a directory on disk. */
async function directoriesAmong(
  root: AppPath,
  paths: readonly string[],
): Promise<string[]> {
  const isDir = await Promise.all(
    paths.map(async (p) => {
      try {
        return (await lstat(join(root, p))).isDirectory();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw err;
      }
    }),
  );
  return paths.filter((_, i) => isDir[i]);
}

// Pathspecs per git child, so a large batch never meets ARG_MAX.
const PATHSPECS_PER_CALL = 1_000;

/** `ls-files <args> -- <paths>` (literal), the paths split across children. */
async function lsFilesChunked(
  root: AppPath,
  args: string[],
  paths: readonly string[],
): Promise<string[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += PATHSPECS_PER_CALL) {
    chunks.push(paths.slice(i, i + PATHSPECS_PER_CALL));
  }
  const outs = await Promise.all(
    chunks.map((chunk) => lsFiles(root, [...args, "--", ...chunk], true)),
  );
  return outs.flat();
}

/** The rest of a porcelain record after its first `n` space-separated fields. */
function fieldsTail(record: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) {
    at = record.indexOf(" ", at) + 1;
    if (at === 0) {
      throw new Error(
        `git status --porcelain=v2: record has fewer than ${n + 1} fields: ${JSON.stringify(record)}`,
      );
    }
  }
  return record.slice(at);
}

/**
 * `loadRepoFiles`' membership, asked of git for `paths` only: the members at or
 * under each (repo-relative; a file or a folder, present or gone — `""` is the
 * whole repo), sorted. Same rule, same two listings, scoped by LITERAL
 * pathspecs — so git walks those folders' untracked content and nothing else.
 * For a long-lived holder of a set that re-asks about what a watcher saw
 * change, instead of listing the whole repo again.
 *
 * Throws on any git failure — never an empty set.
 */
export async function listRepoMembers(
  root: AppPath,
  paths: readonly string[],
): Promise<string[]> {
  for (const p of paths) assertRepoPath("listRepoMembers", p, true);
  if (paths.length === 0) return [];
  const spec = ["--", ...paths.map((p) => (p === "" ? "." : p))];
  const [present, deleted] = await Promise.all([
    lsFiles(
      root,
      ["--cached", "--others", "--exclude-standard", ...spec],
      true,
    ),
    lsFiles(root, ["--deleted", ...spec], true),
  ]);
  return membership(present, deleted);
}

/**
 * The membership rule, once: present minus deleted, deduped (`--cached` and
 * `--others` are disjoint, but an unmerged path has one index entry per stage)
 * and sorted.
 */
function membership(present: string[], deleted: string[]): string[] {
  const gone = new Set(deleted);
  return [...new Set(present.filter((p) => !gone.has(p)))].sort();
}

/**
 * `loadRepoFiles`' set, plus every member's blob id (`RepoSnapshot.blobOf`):
 * the build's one view of the checkout, so no step walks the disk to find out
 * which files exist or reads them to find out whether they changed.
 *
 * Cost follows the change, not the repo. A clean tracked file's id is the
 * index's (`git ls-files -s`, no stat); `git diff-files` names the tracked
 * files whose working-tree stat no longer matches the index (lstat against
 * git's stat cache, no lock taken, no untracked walk), and only those, the
 * untracked files (`listAllRepoMembers`' status pass, no full untracked walk)
 * and `extra` are hashed — by one `git hash-object` child. A
 * file whose stat moved but whose bytes did not is simply hashed again: its id
 * comes out the same.
 *
 * `extra`: gitignored files a step really reads (a codegen writer's
 * per-composition registry). They are not in git's set, so they are named
 * here, hashed, and become members — a file a hash covered is never dropped
 * from it silently. Each must exist: a missing one fails `hash-object`.
 *
 * Same lifetime rule as `loadRepoFiles`: a snapshot of the moment it is
 * called, taken once per pass and handed around, never a module memo.
 */
export async function loadRepoSnapshot(
  root: AppPath,
  opts?: RepoFilesOptions & { extra?: readonly string[] },
): Promise<RepoSnapshot> {
  const extra = opts?.extra ?? [];
  for (const p of extra) assertRepoPath("extra", p, false);
  const [staged, delta, changedOut] = await Promise.all([
    lsFiles(root, ["-s"]),
    worktreeDelta(root),
    git(root, ["--no-optional-locks", "diff-files", "-z", "--name-only"]),
  ]);

  // `<mode> <blob> <stage>\t<path>`. A conflicted path (stage > 0) has no one
  // index id for its working-tree content: hash it like a modified file.
  const indexBlob = new Map<string, string>();
  const unmerged = new Set<string>();
  const tracked: string[] = [];
  for (const entry of staged) {
    const tab = entry.indexOf("\t");
    const [, blob, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    tracked.push(path);
    if (stage === "0") indexBlob.set(path, blob!);
    else unmerged.add(path);
  }
  const changed = new Set(changedOut.split("\0").filter((p) => p.length > 0));
  const paths = membership(
    [...tracked, ...delta.untracked, ...extra],
    delta.deleted,
  );

  const toHash = paths.filter(
    (p) =>
      changed.has(p) ||
      unmerged.has(p) ||
      !indexBlob.has(p) /* untracked or extra */,
  );
  const blobs = new Map(indexBlob);
  if (toHash.length > 0) {
    const out = await git(
      root,
      ["hash-object", "--stdin-paths"],
      toHash.join("\n") + "\n",
    );
    const ids = out.split("\n").filter((l) => l.length > 0);
    if (ids.length !== toHash.length) {
      throw new Error(
        `git hash-object answered ${ids.length} ids for ${toHash.length} paths in ${root}`,
      );
    }
    toHash.forEach((p, i) => blobs.set(p, ids[i]!));
  }

  return repoSnapshotOver(root, paths, (path) => blobs.get(path) ?? null, opts);
}

/**
 * A `RepoSnapshot` over `sorted` (as `repoFilesOver`), each member's blob id
 * answered by `blobOf` — for a caller that already holds the ids (the check
 * runner's tree snapshot, which hashed every file for its cache key). A member
 * `blobOf` has no id for throws, like a path outside the set.
 */
export function repoSnapshotOver(
  root: AppPath,
  sorted: readonly string[],
  blobOf: (path: string) => string | null,
  opts?: RepoFilesOptions,
): RepoSnapshot {
  const files = repoFilesOver(root, sorted, opts);
  return {
    ...files,
    blobOf: (path) => {
      assertRepoPath("blobOf", path, false);
      const blob = files.has(path) ? blobOf(path) : null;
      if (blob === null) {
        throw new Error(
          `RepoSnapshot.blobOf(${JSON.stringify(path)}): not a file of the snapshot of ${root}.`,
        );
      }
      return blob;
    },
  };
}
