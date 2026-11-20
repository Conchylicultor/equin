import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { readdir, realpath } from "@plugins/packages/plugins/timed-fs/core";
import {
  GitError,
  runGit,
  tryRunGit,
} from "@plugins/primitives/plugins/commit-list/server";
import {
  fileExplorerGitIgnored,
  GIT_IGNORED_MAX_NAMES,
  GIT_IGNORED_MAX_PATHS,
  type GitIgnored,
} from "../../shared/resources";

/** `dir` joined under the checkout, refused when it is not a folder below it. */
export function folderIn(root: string, dir: string): string {
  if (dir === "") return root;
  if (
    isAbsolute(dir) ||
    dir.split("/").some((seg) => seg === ".." || seg === "." || seg === "")
  ) {
    throw fileExplorerGitIgnored.refuse(
      "invalid-path",
      `Not a folder path relative to the checkout: ${JSON.stringify(dir)}`,
    );
  }
  return join(root, dir);
}

const byName = (a: Dirent, b: Dirent) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * The folder's entries, the first `GIT_IGNORED_MAX_NAMES` in name order — the
 * entries a listing of it shows. `.git` is never one git judges.
 */
async function entriesOf(abs: string): Promise<Dirent[]> {
  const dirents = await readdir(abs, { withFileTypes: true });
  return dirents
    .filter((d) => d.name !== ".git")
    .sort(byName)
    .slice(0, GIT_IGNORED_MAX_NAMES);
}

/** The asked folder's entries; a folder that is not there is refused. */
async function askedEntries(abs: string): Promise<Dirent[]> {
  try {
    return await entriesOf(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw fileExplorerGitIgnored.refuse("missing", `No such folder: ${abs}`);
    }
    throw err;
  }
}

/**
 * A subfolder's entries, for its row's item count. One that went away or
 * cannot be read holds nothing git could judge — its row says so from its
 * own peek, and the folder watch re-pushes.
 */
async function subfolderEntries(abs: string): Promise<Dirent[]> {
  try {
    return await entriesOf(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return [];
    throw err;
  }
}

/**
 * Which of `relPaths` git's exclude rules match (every `.gitignore`,
 * `info/exclude`, `core.excludesFile`) — `--no-index`, so the index is not
 * read here: tracked paths are filtered by {@link trackedAmong}, and only
 * when some path matched. Each path is asked as `./<path>`, so a name that
 * starts like pathspec magic (`:(glob)…`, `:!…`) is read as a name
 * (check-ignore refuses `--literal-pathspecs`). Exit 1 is git's "none".
 */
async function matchingExcludes(
  root: string,
  relPaths: readonly string[],
): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set();
  const args = ["check-ignore", "--no-index", "-z", "--stdin"];
  const res = await tryRunGit(args, root, {
    stdin: relPaths.map((p) => `./${p}\0`).join(""),
  });
  if (!res.ok && res.exitCode === 1) return new Set();
  if (!res.ok) {
    throw new GitError({
      args,
      cwd: root,
      exitCode: res.exitCode,
      stderr: res.stderr,
    });
  }
  return new Set(
    res.stdout
      .split("\0")
      .filter(Boolean)
      .map((p) => (p.startsWith("./") ? p.slice(2) : p)),
  );
}

/** The most argv bytes one `ls-files` call is given (macOS ARG_MAX is 1 MB). */
const PATHSPEC_CHUNK_BYTES = 128 * 1024;

/** `paths` cut into runs whose summed length stays under the argv budget. */
function chunked(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    if (chunk.length > 0 && bytes + p.length + 1 > PATHSPEC_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(p);
    bytes += p.length + 1;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * Of `relPaths`, those git tracks — a tracked file, or a folder holding one.
 * Git shows what it tracks whatever the exclude rules say (`git status
 * --ignored` lists such a folder's ignored files, not the folder), so these
 * are never hidden. Literal pathspecs, chunked under the argv limit.
 */
async function trackedAmong(
  root: string,
  relPaths: readonly string[],
): Promise<Set<string>> {
  const asked = new Set(relPaths);
  const tracked = new Set<string>();
  for (const chunk of chunked(relPaths)) {
    const out = await runGit(
      ["--literal-pathspecs", "ls-files", "-z", "--", ...chunk],
      root,
    );
    for (const path of out.split("\0")) {
      if (path === "") continue;
      if (asked.has(path)) tracked.add(path);
      for (
        let cut = path.indexOf("/");
        cut >= 0;
        cut = path.indexOf("/", cut + 1)
      ) {
        const dir = path.slice(0, cut);
        if (asked.has(dir)) tracked.add(dir);
      }
    }
  }
  return tracked;
}

/** Of `relPaths`, those git ignores: an exclude rule matches, git tracks none. */
async function ignoredAmong(
  root: string,
  relPaths: readonly string[],
): Promise<Set<string>> {
  const matched = await matchingExcludes(root, relPaths);
  if (matched.size === 0) return matched;
  for (const t of await trackedAmong(root, [...matched])) matched.delete(t);
  return matched;
}

/**
 * Whether the folder lies beyond a symbolic link inside the checkout: git
 * reads nothing past one (`git status` never descends, check-ignore refuses
 * the path), so nothing there is ignored. `root` is git's toplevel, its
 * symlinks already resolved.
 */
async function beyondSymlink(root: string, abs: string): Promise<boolean> {
  return abs !== root && (await realpath(abs)) !== abs;
}

/**
 * The paths git ignores among the entries of the checkout folder `dir`
 * (relative to `root`) and among the entries of each of its subfolders —
 * what a listing of the folder shows: its rows, each collapsed folder's item
 * count, and an expanded subfolder's rows before its own answer lands. Paths
 * are relative to `dir`; what lies below an ignored folder is not listed (it
 * is ignored by prefix). Two rounds — the folder's entries, then the entries
 * of the subfolders git does not ignore — each one `git check-ignore` (plus
 * one `git ls-files` when some path matched). The cost of what the browser
 * shows, never a walk of the tree.
 */
export async function readIgnoredEntries(
  root: string,
  dir: string,
): Promise<GitIgnored> {
  const abs = folderIn(root, dir);
  const entries = await askedEntries(abs);
  if (await beyondSymlink(root, abs)) return { paths: [], truncated: false };
  const rel = (path: string) => (dir === "" ? path : `${dir}/${path}`);
  const top = await ignoredAmong(
    root,
    entries.map((e) => rel(e.name)),
  );
  // A symlinked folder is no directory entry here: git never descends one.
  const subfolders = entries.filter(
    (e) => e.isDirectory() && !top.has(rel(e.name)),
  );
  const below = (
    await Promise.all(
      subfolders.map(async (sub) =>
        (await subfolderEntries(join(abs, sub.name))).map(
          (e) => `${sub.name}/${e.name}`,
        ),
      ),
    )
  ).flat();
  const second = await ignoredAmong(root, below.map(rel));
  // The folder's own entries first: a cut drops subfolder entries only.
  const paths = [
    ...entries.map((e) => e.name).filter((n) => top.has(rel(n))),
    ...below.filter((p) => second.has(rel(p))),
  ];
  return {
    paths: paths.slice(0, GIT_IGNORED_MAX_PATHS),
    truncated: paths.length > GIT_IGNORED_MAX_PATHS,
  };
}

/**
 * Whether a change at `changed` can move the answer for the folder `abs`: the
 * folder itself, one of its entries, or an entry of one of its subfolders.
 */
export function withinTwoLevels(abs: string, changed: string): boolean {
  const r = relative(abs, changed);
  if (r === "") return true;
  if (r.startsWith("..") || isAbsolute(r)) return false;
  return r.split("/").length <= 2;
}

/** Whether a checkout change can move what git ignores. */
export function movesIgnoreRules(change: {
  path: string;
  area: "worktree" | "git";
}): boolean {
  // The git dir: `info/exclude`, and the index (a `git add -f` or `rm
  // --cached` makes a path tracked or not). A `.gitignore` anywhere above.
  return change.area === "git" || basename(change.path) === ".gitignore";
}
