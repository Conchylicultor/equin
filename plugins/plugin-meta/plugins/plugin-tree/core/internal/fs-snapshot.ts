import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import {
  isTestCodePath,
  TESTS_DIR,
  TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";
import type { FsSnapshot } from "@plugins/plugin-meta/plugins/parse-utils/core";

/**
 * Build-scoped, read-once, parallel in-memory FS snapshot for facet extraction.
 *
 * The facet-extraction pass re-reads the whole plugin source tree several times
 * over (once per file-walking facet) via synchronous `readFileSync` /
 * `readdirSync`, monopolizing the single event loop for many seconds. This walks
 * the needed directories ONCE, asynchronously and in parallel (OS-saturating,
 * non-blocking), reading every source file a single time into memory. Wired into
 * the extract loop via `runWithFsSnapshot`, it makes the (still-synchronous)
 * facet `extract()` functions touch zero disk.
 *
 * Coverage mirrors what the parse-utils scanners read: `walkFiles` surfaces
 * `.ts`/`.tsx` (and `.css` for a scanner that asks), and `readIfExists`
 * additionally reads `package.json`. We record
 * every directory we descend into (so an absent file resolves to `null` with no
 * syscall) and read exactly those file kinds. Any directory NOT covered here is
 * transparently re-read from disk by the helpers, so the snapshot only ever
 * speeds things up — it can never change a scanner's result.
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

export async function buildFsSnapshot(
  pluginDirs: string[],
): Promise<FsSnapshot> {
  const files = new Map<string, string>();
  const dirs = new Map<string, Dirent[]>();

  async function walk(dir: string): Promise<void> {
    if (dirs.has(dir)) return; // already covered (disjoint roots, but guard)
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code == null) throw err;
      return;
    }
    dirs.set(dir, entries);
    const tasks: Promise<void>[] = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (isSkippedDir(e.name)) continue;
        tasks.push(walk(p));
      } else if (e.isFile() && shouldRead(e.name)) {
        tasks.push(
          readFile(p, "utf8").then((content) => {
            files.set(p, content);
          }),
        );
      }
    }
    await Promise.all(tasks);
  }

  await Promise.all(pluginDirs.map((d) => walk(d)));
  return { files, dirs };
}
