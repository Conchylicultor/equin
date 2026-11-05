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

import { readFile } from "@plugins/packages/plugins/timed-fs/core";
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

async function lsFiles(root: string, args: string[]): Promise<string[]> {
  const out = await git(root, ["ls-files", "-z", ...args]);
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
  const gate = createSemaphore(opts?.readConcurrency ?? READ_CONCURRENCY);
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
      return gate.run(() => readWorkingTree(root, path));
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
  const [present, deleted] = await Promise.all([
    lsFiles(root, ["--cached", "--others", "--exclude-standard"]),
    lsFiles(root, ["--deleted"]),
  ]);
  return repoFilesOver(root, membership(present, deleted), opts);
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
 * untracked files and `extra` are hashed — by one `git hash-object` child. A
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
  const [staged, others, deleted, changedOut] = await Promise.all([
    lsFiles(root, ["-s"]),
    lsFiles(root, ["--others", "--exclude-standard"]),
    lsFiles(root, ["--deleted"]),
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
  const paths = membership([...tracked, ...others, ...extra], deleted);

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
