import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  gitWorktreesDir,
  worktreePathFor,
  isCanonicalWorktreeName,
} from "@plugins/infra/plugins/worktree/server";
import { dirExists } from "./reap";

export interface WorktreeDir {
  name: string;
  path: string;
}

export interface WorktreeDirIndex {
  // EVERY dirent name in `<root>/.claude/worktrees`, unfiltered by node type and
  // unfiltered by isCanonicalWorktreeName — the exact set a `stat` of a child path
  // would find, so it can stand in for one.
  //
  // THE FILTERING IS THE WHOLE POINT OF KEEPING TWO LISTS. A caller asking "is
  // this attempt's dir still there?" must consult `allNames`, NEVER `canonical`:
  // a dir whose name fails the regex, or that is a symlink rather than a real
  // directory, is absent from `canonical` but very much present on disk. Reading
  // it as absent routes the attempt down the age-free orphan branch, which
  // removes the dir with no hygiene check and no age floor. See the matching
  // comment at the `hasDir` computation in reap-policy.ts.
  allNames: Set<string>;
  // The canonical-shaped worktree dirs — real directories whose name matches
  // isCanonicalWorktreeName. Safe to enumerate as "the worktrees this system created".
  canonical: WorktreeDir[];
}

// ONE readdir of the git worktree parent (`<root>/.claude/worktrees`), returning
// both the membership set and the canonical list. A missing parent dir (ENOENT)
// yields empty halves; any other error is surfaced loudly. Reads the GIT worktree
// parent, NOT the `~/.equin` registry that `readRegistryNames` walks.
//
// One readdir answers "does this dir exist" for every id at once, which is what
// lets the reaper classify thousands of attempt rows without a stat each.
export async function readWorktreeDirIndex(
  root: string,
): Promise<WorktreeDirIndex> {
  const dir = gitWorktreesDir(root);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return {
      allNames: new Set(entries.map((e) => e.name)),
      canonical: entries
        .filter((e) => e.isDirectory() && isCanonicalWorktreeName(e.name))
        .map((e) => ({ name: e.name, path: join(dir, e.name) })),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { allNames: new Set(), canonical: [] };
    throw err;
  }
}

// Canonical-shaped worktree dirs actually present on disk. Delegates to
// `readWorktreeDirIndex` so the UI list handler and the reaper share one
// enumeration and can never disagree about what is on disk.
export async function readWorktreeDirs(root: string): Promise<WorktreeDir[]> {
  return (await readWorktreeDirIndex(root)).canonical;
}

// Age of a worktree dir that has no attempt row to date it. `git worktree add`
// creates the dir, so birthtime IS the checkout time. mtime is the fallback for
// filesystems that do not record birthtime (0): it can only ever be NEWER than
// the true creation time, so the fallback can delay a reap but never rush one.
export async function dirAgeMs(path: string, now: number): Promise<number> {
  const st = await stat(path);
  return now - (st.birthtimeMs || st.mtimeMs);
}

// Whether "this dir has no attempt row" is decidable HERE. It is not decidable
// on a worktree backend: its DB is a fork taken at checkout time, so every
// worktree created since the fork is simply absent from its `attempts` table and
// would read as an orphan — including live ones. Only main's table is complete.
//
// These routes are registered on every backend (the Debug pane is per-worktree),
// so without this gate the orphan pass would list live worktrees as abandoned and
// hand their Delete button a loaded gun. The reap job is already main-only for the
// same reason; this is that same scoping, enforced at the classification itself.
export function canClassifyOrphans(): boolean {
  return isMain();
}

// The worktree dir for an id with NO attempt row to name it, or null when there
// is no such dir. The name check is load-bearing, not cosmetic: it is the only
// thing standing between a caller-supplied id and the unguarded `dropDatabase(id)`
// / `rm(<config>/id)` steps inside reapAttempt, which a traversal id would walk
// straight out of. Attempt-backed callers get their path from the row instead.
export async function orphanDirPath(id: string): Promise<string | null> {
  if (!canClassifyOrphans()) return null;
  if (!isCanonicalWorktreeName(id)) return null;
  const path = await worktreePathFor(id);
  return (await dirExists(path)) ? path : null;
}
