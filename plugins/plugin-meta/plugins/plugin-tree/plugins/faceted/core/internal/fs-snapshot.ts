import { join, relative } from "node:path";
import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import {
  isTestCodePath,
  TESTS_DIR,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import type {
  FsSnapshot,
  SnapshotDirEntry,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { type AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Build-scoped, read-once, parallel in-memory FS snapshot for facet extraction.
 *
 * The facet-extraction pass re-reads the whole plugin source tree several times
 * over (once per file-walking facet) via synchronous `readFileSync` /
 * `readdirSync`, monopolizing the single event loop for many seconds. This lists
 * the needed directories ONCE from the repo's file set (no `readdir`: the
 * entries are derived from the paths) and reads every source file a single time
 * into memory, asynchronously. Wired into the extract loop via
 * `runWithFsSnapshot`, it makes the (still-synchronous) facet `extract()`
 * functions touch zero disk.
 *
 * Coverage mirrors what the parse-utils scanners read: `walkFiles` surfaces
 * `.ts`/`.tsx` (and `.css` for a scanner that asks), and `readIfExists`
 * additionally reads `package.json`. We record
 * every directory we descend into (so an absent file resolves to `null` with no
 * syscall) and read exactly those file kinds. A directory is an entry of its
 * parent when it holds at least one file of the set — one holding only
 * gitignored files (`node_modules`, build output) is absent, as it is in a
 * fresh checkout. Any directory NOT covered here is
 * transparently re-read from disk by the helpers, so the snapshot only ever
 * speeds things up — it can never change a scanner's result.
 *
 * Membership is git's, not the disk's: a file `.gitignore` covers (a build's
 * gitignored `*.generated.ts`) is left out of both `files` and its directory's
 * entries, so no scanner sees it. Docgen output is committed and checked by
 * `plugins-doc-in-sync`, so it must be a function of the checkout — the same
 * universe (tracked + untracked-not-ignored) the check cache keys on. Reading
 * the disk instead made the doc depend on whether a build had already written
 * such a file: `config_v2/web/internal/git-layer.generated.ts`, written by a
 * codegen step that runs after docgen, failed main's first build after it
 * landed and passed every later one.
 */

// Same directory-skip rules as `walkFiles` (`node_modules` / `plugins` /
// test-code dirs), plus dot-dirs and build output (`dist*`) which are never
// plugin source. `plugins` is skipped because each sub-plugin dir is walked
// from its own root (every plugin dir is passed in), so descending into it
// would double-read.
function isSkippedDir(name: string): boolean {
  return (
    name === "node_modules" ||
    name === "plugins" ||
    name === TESTS_DIR ||
    name === TESTING_FOLDER ||
    name.startsWith(".") ||
    name.startsWith("dist")
  );
}

// Only the file kinds the scanners pass to `readIfExists` / surface from
// `walkFiles`. Keeps the snapshot tight while covering every read. Mirrors
// `walkFiles`' exclusion of test code (via `isTestCodePath`), which is never
// part of a plugin's API/dep surface.
function shouldRead(name: string): boolean {
  if (name === "package.json") return true;
  return /\.(ts|tsx|css)$/.test(name) && !isTestCodePath([name]);
}

function entry(name: string, dir: boolean): SnapshotDirEntry {
  return { name, isFile: () => !dir, isDirectory: () => dir };
}

/**
 * What a plugin's snapshot holds, as one line per entry: every path it lists
 * (a skipped directory by its name alone), with the blob id of each file it
 * reads. Exactly the inputs of a facet's `extract` of that plugin — so the
 * plugin's records are keyed by it, and a change the snapshot cannot see (a
 * sub-plugin's file, a test) moves no record.
 */
export function pluginFilesManifest(
  repo: RepoSnapshot,
  pluginDir: AppPath,
): string[] {
  const rel = relative(repo.root, pluginDir);
  const lines = new Set<string>();
  for (const path of repo.under(rel)) {
    const segs = path.slice(rel.length + 1).split("/");
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i]!;
      const sub = segs.slice(0, i + 1).join("/");
      if (i === segs.length - 1) {
        lines.add(shouldRead(name) ? `${sub}\t${repo.blobOf(path)}` : sub);
        break;
      }
      if (isSkippedDir(name)) {
        lines.add(`${sub}/`);
        break;
      }
    }
  }
  return [...lines];
}

export async function buildFsSnapshot(
  repo: RepoFiles,
  pluginDirs: readonly AppPath[],
  opts?: { strict?: string },
): Promise<FsSnapshot> {
  const files = new Map<string, string>();
  // dir → name → is it a directory. Insertion follows the sorted path list.
  const listing = new Map<string, Map<string, boolean>>();
  const reads: Promise<void>[] = [];

  for (const pluginDir of pluginDirs) {
    const rel = relative(repo.root, pluginDir);
    if (listing.has(pluginDir)) continue; // disjoint roots, but guard
    listing.set(pluginDir, new Map());
    for (const path of repo.under(rel)) {
      const segs = path.slice(rel.length + 1).split("/");
      let dir: string = pluginDir;
      for (let i = 0; i < segs.length; i++) {
        const name = segs[i]!;
        const isDir = i < segs.length - 1;
        listing.get(dir)!.set(name, isDir);
        if (!isDir) {
          if (shouldRead(name)) {
            const abs = join(dir, name);
            reads.push(
              repo.read(path).then((content) => {
                // Null: removed after the set was taken — absent, like a
                // file the walk never saw.
                if (content !== null) files.set(abs, content);
              }),
            );
          }
          break;
        }
        if (isSkippedDir(name)) break;
        dir = join(dir, name);
        if (!listing.has(dir)) listing.set(dir, new Map());
      }
    }
  }

  await Promise.all(reads);
  const dirs = new Map<string, SnapshotDirEntry[]>();
  for (const [dir, names] of listing) {
    dirs.set(
      dir,
      [...names].map(([name, isDir]) => entry(name, isDir)),
    );
  }
  return { files, dirs, ...(opts?.strict ? { strict: opts.strict } : {}) };
}
