import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { type DirtyEntry, editedFilesEtag, parsePorcelainZ } from "./edited-files-etag";

// lstat one dirty path for its (mtime, size) — git's stat-cache dirty signal.
// A deleted/vanished path (status "D", or a race) can't be stat'd; ENOENT is the
// expected case there, so we degrade to -1 sentinels (which still flip the ETag on
// a present→deleted transition — the porcelain code changes too). Any OTHER error
// is unexpected and re-thrown so it fails loudly rather than serving a signature
// built on a silent read failure.
async function statEntry(
  worktreePath: string,
  entry: { code: string; path: string },
): Promise<DirtyEntry> {
  try {
    const st = await lstat(resolve(worktreePath, entry.path));
    return { code: entry.code, path: entry.path, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { code: entry.code, path: entry.path, mtimeMs: -1, size: -1 };
  }
}

/**
 * What one `git status` (and the merge-base beside it) says about a worktree —
 * read ONCE per pass and shared: `computeEditedFiles` layers the dirty entries
 * over the branch diff, and `editedFilesSignatureOf` fingerprints them.
 */
export interface EditedFilesFacts {
  mergeBase: string;
  /** `git status --porcelain --no-renames -uall -z`'s entries: raw paths, never C-quoted. */
  dirty: ReadonlyArray<{ code: string; path: string }>;
}

/**
 * Read the facts: `merge-base main HEAD` ‖ the dirty entries. Ungated (no
 * heavy slot) — the status walk is the expensive half of a probe, so each pass
 * or probe reads it once and hands it on. runGit throws on failure (never a
 * manufactured value), so a failed read can never stand in for a clean tree.
 *
 * The entries are exactly `git status --porcelain --no-renames -uall -z`'s,
 * read as `-unormal` plus an `ls-files --others` of each untracked directory it
 * names: `-uall` matches every path of the checkout against the excludes (~3×
 * the paths a `-unormal` walk visits on this repo, 0.7 s vs 0.2 s), where the
 * two-step read walks only the untracked directories again. An embedded repo
 * stays one `dir/` entry either way.
 */
export async function readEditedFilesFacts(
  worktreePath: string,
): Promise<EditedFilesFacts> {
  const [mergeBase, statusZ] = await Promise.all([
    runGit(["merge-base", "main", "HEAD"], worktreePath),
    runGit(
      [
        "status",
        "--porcelain",
        "--no-renames",
        "--untracked-files=normal",
        "-z",
      ],
      worktreePath,
    ),
  ]);
  const entries = parsePorcelainZ(statusZ);
  const untrackedDirs = entries
    .filter((e) => e.code === "??" && e.path.endsWith("/"))
    .map((e) => e.path);
  if (untrackedDirs.length === 0) {
    return { mergeBase: mergeBase.trim(), dirty: entries };
  }
  const othersZ = await runGit(
    [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ...untrackedDirs,
    ],
    worktreePath,
  );
  const expanded = othersZ
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => ({ code: "??", path }));
  const dirs = new Set(untrackedDirs);
  return {
    mergeBase: mergeBase.trim(),
    dirty: [
      ...entries.filter((e) => !(e.code === "??" && dirs.has(e.path))),
      ...expanded,
    ],
  };
}

/**
 * The CONTENT signature of `edited-files` for one worktree, over facts already
 * read — the unwatched path's fingerprint in the watched memo
 * (edited-files-cache.ts).
 *
 * It is a faithful, conservative over-approximation: it changes whenever
 * `computeEditedFiles`' value could change (serving stale is a correctness bug;
 * a needless recompute is merely a missed optimization).
 *
 *   - `(headSha, mergeBase)` covers the committed branch diff. Both name
 *     immutable trees, so a commit/amend/rebase moves headSha and a `main`
 *     advance moves mergeBase. A porcelain-only signature would MISS an amend
 *     that leaves the working tree clean.
 *   - The per-dirty-file `(code, lstat mtimeMs+size)` covers the uncommitted
 *     working-tree changes AND their line counts. Porcelain output alone is NOT
 *     enough: a file already `M` can gain more edits while its status line stays
 *     identical, yet its numstat (and thus the value) changes. Folding in git's
 *     own stat-cache dirty signal catches that with one `lstat` per dirty file
 *     (no content read).
 *
 * Adds 1 `rev-parse HEAD` + an `lstat` per dirty file to the facts. Ungated.
 *
 * See research/2026-07-09-global-etag-value-coproduction.md.
 */
export async function editedFilesSignatureOf(
  worktreePath: string,
  facts: EditedFilesFacts,
): Promise<string> {
  const [headSha, entries] = await Promise.all([
    runGit(["rev-parse", "HEAD"], worktreePath),
    Promise.all(facts.dirty.map((e) => statEntry(worktreePath, e))),
  ]);
  return editedFilesEtag(headSha, facts.mergeBase, entries);
}

/**
 * The content signature read from scratch: {@link readEditedFilesFacts} then
 * {@link editedFilesSignatureOf}. For a reader keying its own memo on the
 * edited-file set (review/plugin-changes).
 *
 * This module is a LEAF on purpose: the memo declaration imports it, so it must
 * never import the memo back (import cycle).
 */
export async function editedFilesSignature(worktreePath: string): Promise<string> {
  return editedFilesSignatureOf(
    worktreePath,
    await readEditedFilesFacts(worktreePath),
  );
}
