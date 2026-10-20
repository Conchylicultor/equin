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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { globPaths, pathsUnder } from "./pathspec";
import type { RepoFiles } from "./types";

// Wedge-breaker for a metadata-only git read, not a latency budget: what these
// suffer under a saturated check run is starvation, not slowness. Same bound
// and same reasoning as the check runner's read-set GIT_TIMEOUT_MS.
const GIT_TIMEOUT_MS = 60_000;

// How many `read()`s one set holds open at once. A check run has ONE set,
// shared by every check, so this is the run's bound, not a check's: a caller
// that hands `read` seven thousand paths at once opens this many and queues the
// rest. Wide enough that one such caller does not park another's single read
// behind it for long.
const READ_CONCURRENCY = 64;

async function lsFiles(root: string, args: string[]): Promise<string[]> {
  const result = await spawnCaptured(["git", "ls-files", "-z", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    // Loud, never `[]`. An absorbed failure here would tell every caller the
    // repo is empty, turning each file rule into a vacuous PASS.
    throw new Error(
      `git ls-files ${args.join(" ")} failed in ${root} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split("\0").filter((p) => p.length > 0);
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
  root: string,
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
 * under `root`. For a caller that already holds the listing (the check
 * runner's tree snapshot); everyone else calls `loadRepoFiles`.
 */
export function repoFilesOver(
  root: string,
  sorted: readonly string[],
): RepoFiles {
  const paths = Object.freeze(sorted);
  const members = new Set(paths);
  const gate = createSemaphore(READ_CONCURRENCY);
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
export async function loadRepoFiles(root: string): Promise<RepoFiles> {
  const [present, deleted] = await Promise.all([
    lsFiles(root, ["--cached", "--others", "--exclude-standard"]),
    lsFiles(root, ["--deleted"]),
  ]);
  const gone = new Set(deleted);
  // `--cached` and `--others` are disjoint, but an unmerged path has one index
  // entry per stage — so dedupe rather than assume.
  return repoFilesOver(
    root,
    [...new Set(present.filter((p) => !gone.has(p)))].sort(),
  );
}
