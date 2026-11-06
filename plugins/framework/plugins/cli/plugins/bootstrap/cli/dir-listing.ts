/**
 * The workspace roots' directory listing, kept between runs so a walk lists
 * only the directories that changed.
 *
 * `ensureDeps` runs in EVERY `./equin` process, and the set of dep inputs it
 * fingerprints is "every `package.json` (and `provision/index.ts`) at any depth
 * under the workspace roots". Finding them was a readdir of every directory
 * under `plugins/` — 8,307 dirs and 19.7k files on 2026-11-06, ~0.5 s of mostly
 * sys time per process, twice per build (the build and its check child).
 *
 * A directory's entries can only change by an entry being added, removed or
 * renamed in it, and each of those moves the directory's own mtime and ctime.
 * So each directory's listing is recorded under its stat stamp `(ino, mtime,
 * ctime)`: a run still visits every directory, but with one `stat` instead of
 * a readdir, and re-lists a directory only when its stamp moved (a new
 * subdirectory found there is listed whole, as it has no record). ctime cannot
 * be set by a user, so a tool that restores an old mtime still moves the stamp;
 * the inode catches a directory swapped for another by rename.
 *
 * The record is an optimisation of the walk, never a source of truth: what it
 * returns is exactly what a full walk would, a missing or unreadable record is
 * a full walk, and it lives inside `node_modules` beside the deps stamp, so
 * removing `node_modules` drops it too.
 *
 * PRE-INSTALL-SAFE, like `ensure-deps.ts`: node builtins, relative modules and
 * `@plugins/*` aliases only.
 */
import { type Dirent, renameSync, writeFileSync } from "node:fs";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { dirname, join } from "node:path";

/** Bumped when the record's shape changes; another version reads as none. */
const LISTING_VERSION = 1;

/** One directory's listing, as last read. */
interface DirRecord {
  /** `ino:mtimeNs:ctimeNs` of the directory when it was read. */
  stamp: string;
  /** Subdirectories to descend into (names; skipped names already removed). */
  dirs: string[];
  /** Plain files (names) among the walk's `keepNames`. */
  files: string[];
}

interface ListingFile {
  version: number;
  /**
   * What the listings were filtered by (`keepNames` and `skip`, sorted). Part
   * of what each listing means: a record made under another filter is no
   * record, so a name added to the filter is never served a listing that
   * dropped it.
   */
  filter: string;
  /** Keyed by the directory's path relative to the repo root. */
  dirs: Record<string, DirRecord>;
}

/** What a walk saw: every kept plain file under the roots, repo-relative. */
export interface WalkedFiles {
  files: string[];
  /** Directories listed by readdir this run (the rest came from the record). */
  relisted: number;
  /** Directories visited. */
  visited: number;
}

function filterKey(
  keepNames: ReadonlySet<string>,
  skip: ReadonlySet<string>,
): string {
  return JSON.stringify([[...keepNames].sort(), [...skip].sort()]);
}

function readListing(path: string, filter: string): Record<string, DirRecord> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ListingFile>;
    if (
      parsed.version !== LISTING_VERSION ||
      parsed.filter !== filter ||
      typeof parsed.dirs !== "object"
    )
      return {};
    return parsed.dirs ?? {};
  } catch (err) {
    // A torn or foreign record says nothing about the tree: the sound reading
    // is "no record", i.e. a full walk — never a smaller answer.
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

function writeListing(
  path: string,
  filter: string,
  dirs: Record<string, DirRecord>,
): void {
  // Never creates its directory: the record lives inside `node_modules`, and
  // a `node_modules` holding only it would read as installed to whoever
  // populates a fresh checkout (the worktree's pooled dep store adoption).
  // With no directory the walk simply was a full one, and is next time.
  if (!existsSync(dirname(path))) return;
  const temp = `${path}.tmp.${process.pid}`;
  const body: ListingFile = { version: LISTING_VERSION, filter, dirs };
  writeFileSync(temp, JSON.stringify(body));
  renameSync(temp, path);
}

/**
 * Every plain file under `roots` (repo-relative directories, `""` = the root)
 * whose name is in `keepNames`, skipping directories named in `skip` and
 * never following a symlink — the same answer as a recursive readdir walk,
 * reading only directories whose stat stamp moved since `listingPath` was last
 * written under the same filter. Writes the record back when anything was
 * re-listed or dropped, and only when its directory exists (atomically:
 * concurrent processes each write a complete record, the last rename wins).
 *
 * A directory that vanishes mid-walk is skipped (`ENOENT`), as the walk did:
 * codegen and the `dist.*` swap rename directories under `plugins/`.
 */
export function walkFilesWithListing(
  root: string,
  roots: readonly string[],
  skip: ReadonlySet<string>,
  keepNames: ReadonlySet<string>,
  listingPath: string,
): WalkedFiles {
  const filter = filterKey(keepNames, skip);
  const prev = readListing(listingPath, filter);
  const next: Record<string, DirRecord> = {};
  const files: string[] = [];
  let relisted = 0;
  let visited = 0;

  const visit = (rel: string): void => {
    const abs = rel === "" ? root : join(root, rel);
    let st;
    try {
      st = statSync(abs, { bigint: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw err;
    }
    if (!st.isDirectory()) return;
    visited++;
    const stamp = `${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
    let record = prev[rel];
    if (record === undefined || record.stamp !== stamp) {
      let entries: Dirent[];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      relisted++;
      const dirs: string[] = [];
      const plain: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) dirs.push(entry.name);
        } else if (entry.isFile() && keepNames.has(entry.name)) {
          // Plain files only: a symlinked dir is never followed, which is what
          // keeps the walk cycle-free.
          plain.push(entry.name);
        }
      }
      record = { stamp, dirs, files: plain };
    }
    next[rel] = record;
    for (const name of record.files) {
      files.push(rel === "" ? name : `${rel}/${name}`);
    }
    for (const name of record.dirs) visit(rel === "" ? name : `${rel}/${name}`);
  };
  for (const r of roots) visit(r);

  const dropped = Object.keys(prev).some((k) => !(k in next));
  if (relisted > 0 || dropped) writeListing(listingPath, filter, next);
  return { files, relisted, visited };
}
