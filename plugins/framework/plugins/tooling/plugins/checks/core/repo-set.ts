// The run's file set — what every check gets from `ctx.repo()`.
//
// Every check in a pass shares ONE JS thread, and an agent's check pass runs at
// background priority, where a blocking `readdirSync` / `existsSync` /
// `readFileSync` per file costs ~100× what it costs alone — and holds the
// thread against every other check the whole time. So the set is loaded ONCE
// per run and shared (`tooling/core`'s `RepoFiles`: membership in memory,
// content through one bounded async gate).
//
// This file adds the two things only a check run has: the cache key's own tree
// snapshot as the set's source — so a check enumerates exactly the files its
// key hashed — and read-set recording for an input-keyed check.

import {
  assertRepoPath,
  loadRepoFiles,
  repoFilesOver,
  type RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import type { FileSystemView, TreeSnapshot } from "./read-set";

/**
 * `base`, with every fact an input-keyed check reads through it recorded into
 * `view`, so a PASS replayed from that read-set is exactly as fresh as what the
 * check saw. `base` must be the set over the view's own snapshot — the run's
 * `ctx.repo()` is, whenever a view exists.
 *
 * Membership is answered BY the view — the same snapshot projections `validate`
 * replays — so what is recorded and what was answered cannot differ:
 *   - `has(p)`     → `view.exists(p)`: a content fact when present, an absent
 *                    probe when not.
 *   - `under(dir)` → `view.glob("<dir>/**")`: the subtree's membership, so a
 *                    file added under it or removed from it is a MISS. The
 *                    snapshot answers that pattern with two binary searches.
 *   - `glob(pat)`  → `view.glob(pat)`: that pattern's match set.
 *   - `all()`      → `view.glob("**")`: the whole tree's membership.
 *   - `read(p)`    → `view.recordFile(p)`, then `base.read(p)` off the working
 *                    tree. Not `view.readFile`, which reads the blob with one
 *                    `git cat-file` spawn per call. `recordFile` takes the
 *                    blob sha from the snapshot — how grepCode, type-check and
 *                    plugin-boundaries already record bytes they read off
 *                    disk. The working tree holds the snapshot's content unless
 *                    the file changed after the run took its tree hash, the
 *                    window every disk-reading check already has.
 * The view keeps one fact per path / pattern, so a file recorded here AND by a
 * check's own eager read-set is one fact.
 */
export function recordingRepoFiles(
  base: RepoFiles,
  view: FileSystemView,
): RepoFiles {
  return {
    root: base.root,
    all: () => view.glob("**"),
    has: (path) => {
      assertRepoPath("has", path, false);
      return view.exists(path);
    },
    under: (dir) => {
      assertRepoPath("under", dir, true);
      return view.glob(dir === "" ? "**" : `${dir}/**`);
    },
    glob: (pattern) => view.glob(pattern),
    read: async (path) => {
      assertRepoPath("read", path, false);
      view.recordFile(path);
      return base.read(path);
    },
  };
}

/**
 * `ctx.repo()` for an input-keyed check: the run's set, recorded into `view`.
 * Memoized like the run's own, so the check holds one instance however often
 * it asks.
 */
export function recordingRepo(
  repo: () => Promise<RepoFiles>,
  view: FileSystemView,
): () => Promise<RepoFiles> {
  let recorded: Promise<RepoFiles> | null = null;
  return () =>
    (recorded ??= repo().then((files) => recordingRepoFiles(files, view)));
}

/**
 * The run's `ctx.repo()`: the first call loads the set, and every later call —
 * from any check — gets the same promise.
 *
 * Where the set comes from, in order:
 *   1. the run's tree snapshot. `loadSnapshot` is the runner's own memoized
 *      load: already done when an input-keyed check is selected, done here
 *      otherwise. The set is then the tree the cache key hashed.
 *   2. `loadRepoFiles(root)` when there is no snapshot: `--no-cache` computes
 *      no tree hash, and the snapshot load is fail-open (null on any git
 *      failure). The same universe, asked of git directly — and the same
 *      implementation build-time codegen uses.
 * A failure of (2) rejects, and every check that asked fails itself, naming
 * it. Never an empty set: that would pass every rule that iterates it.
 */
export function runRepoFiles(source: {
  loadSnapshot: () => Promise<TreeSnapshot | null>;
  root: () => Promise<string>;
}): () => Promise<RepoFiles> {
  const load = async (): Promise<RepoFiles> => {
    const snapshot = await source.loadSnapshot();
    if (snapshot !== null) {
      return repoFilesOver(snapshot.root, snapshot.paths());
    }
    return loadRepoFiles(await source.root());
  };
  let loaded: Promise<RepoFiles> | null = null;
  return () => (loaded ??= load());
}
