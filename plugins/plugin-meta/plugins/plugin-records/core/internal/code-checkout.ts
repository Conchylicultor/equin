import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { parseBunLock } from "@plugins/infra/plugins/deps/plugins/npm/plugins/lock-closure/core";
import type { ModuleGraphInput } from "./module-graph";
import { outsideFilesOf } from "./outside-files";

/**
 * Where a record producer's CODE is read from to key its records — never
 * assumed to be the file set it reads.
 *
 * A scan's identity is the Merkle key of the module that runs it, and the
 * module that runs is the one this process loaded: it lives in the checkout
 * its `import.meta.url` names. When the set being read IS that checkout (a
 * build or a check pass over its own tree, the common case) the set is the
 * freshest view of the same files — the build's written overlay included —
 * and is used as it is. Any other set (a fixture, another checkout) holds the
 * DATA, not the code: the code is read from its own checkout, so a fixture
 * scanned through a cached scan needs no copy of the scanner, and no fixture
 * can stand in for the code that really ran.
 *
 * Judged by the root's spelling: a set reaching the same checkout through
 * another spelling (a symlink) is read as foreign — the same files, read from
 * the disk, never a wrong key.
 */

/** Whether the module at `path` (absolute) is a file under `root`. */
function isUnder(root: string, path: string): boolean {
  return path.startsWith(`${root}/`);
}

// The running checkout as a module-graph input, once per process: its code
// does not change under the process that loaded it.
let running:
  | Promise<Pick<ModuleGraphInput, "snapshot" | "readOutside">>
  | undefined;

/**
 * The running checkout as the module graph reads a producer's code from it:
 * a set holding only `bun.lock` and the patch files it applies (what the npm
 * key reads), every module read from the disk as a file outside the set —
 * the graph resolves, hashes and scans it the same, and no listing of the
 * whole checkout (a git snapshot) is taken for a closure of a few dozen files.
 */
async function lockSetAt(
  root: AppPath,
): Promise<Pick<ModuleGraphInput, "snapshot" | "readOutside">> {
  // The set's members are filled once read; its one reader (`outsideFilesOf`,
  // by the set's identity) reads them and every module outside it.
  const members = new Map<string, string>();
  let paths: string[] = [];
  const set: RepoFiles = {
    root,
    all: () => paths,
    has: (p) => members.has(p),
    under: (dir) =>
      dir === "" ? paths : paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: (pattern) => {
      throw new Error(
        `[plugin-records] the running checkout's lock set holds only bun.lock and its patches: glob(${pattern}) is not asked of it`,
      );
    },
    read: async (p) => members.get(p) ?? null,
  };
  const readOutside = outsideFilesOf(set);
  const lock = await readOutside("bun.lock");
  if (lock !== null) {
    members.set("bun.lock", lock);
    for (const patch of Object.values(parseBunLock(lock).patched)) {
      const text = await readOutside(patch);
      if (text !== null) members.set(patch, text);
    }
  }
  paths = [...members.keys()].sort();
  return { snapshot: set, readOutside };
}

/**
 * The module-graph input to read the code at `url` from, and the module's
 * repo-relative path in it: `input` itself when its set is the checkout the
 * module lives in, else the checkout this process runs from (the module must
 * be one of its own).
 */
export async function codeCheckoutOf(
  input: ModuleGraphInput,
  url: string,
): Promise<{ input: ModuleGraphInput; module: string }> {
  const path = decodeURIComponent(new URL(url).pathname);
  const set = input.snapshot.root;
  const root = REPO_ROOT;
  // The module lives in the most specific checkout around it: a worktree sits
  // INSIDE main's checkout (`.claude/worktrees/<id>/`), so a worktree's
  // process reading main's set holds code that is under main's root too.
  const inRunning = isUnder(root, path) && root.length > set.length;
  if (isUnder(set, path) && !inRunning)
    return { input, module: path.slice(set.length + 1) };
  if (!isUnder(root, path))
    throw new Error(
      `[plugin-records] ${url} is neither in the set read (${input.snapshot.root}) nor in the checkout this process runs from (${root}): a producer's identity is its defining module`,
    );
  // A failed read is not kept: the next identity asks the disk again.
  running ??= lockSetAt(root).catch((err: unknown) => {
    running = undefined;
    throw err;
  });
  return {
    input: { ...(await running), store: input.store },
    module: path.slice(root.length + 1),
  };
}
