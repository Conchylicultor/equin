import { stat } from "node:fs/promises";
import {
  runGit,
  tryRunGit,
} from "@plugins/primitives/plugins/commit-list/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  fileExplorerGitCheckoutValue,
  type GitCheckout,
} from "../../shared/resources";

/** How many folders' answers are remembered (oldest dropped first). */
const MEMO_MAX = 512;

/**
 * Positive answers by folder. A folder's checkout only changes when a repo is
 * created or removed around it, so a found one is kept; a "none" is asked
 * again on the next visit, which is what makes a `git init` show up.
 */
const memo = new Map<string, Extract<GitCheckout, { kind: "checkout" }>>();

/** Every toplevel an answer named — the roots the status value accepts. */
const knownRoots = new Set<string>();

/** Whether `dir` is a directory this account can enter. */
async function isEnterableDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      return false;
    }
    throw err;
  }
}

/**
 * The checkout holding the absolute folder `dir`. A folder that is missing,
 * denied, outside any work tree or inside a `.git` dir is in none.
 */
export async function resolveCheckout(dir: string): Promise<GitCheckout> {
  if (!dir.startsWith("/")) throw new Error(`Not an absolute path: ${dir}`);
  const hit = memo.get(dir);
  if (hit !== undefined) return hit;
  if (!(await isEnterableDir(dir))) return { kind: "none" };
  // Exit 128 is git's "not a git repository" / "must be run in a work tree":
  // the folder is in no checkout, which is an answer, not a failure.
  const res = await tryRunGit(
    ["rev-parse", "--show-toplevel", "--show-prefix"],
    dir,
  );
  if (!res.ok) {
    if (res.exitCode === 128) return { kind: "none" };
    throw new Error(
      `git rev-parse in ${dir} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
  const [root = "", prefix = ""] = res.stdout.split("\n");
  // `--show-prefix` is the folder below the toplevel (`a/b/`), so the root as
  // `dir` spells it is `dir` minus that suffix — the same folder, without the
  // symlinks git resolved.
  const below = prefix.endsWith("/") ? `/${prefix.slice(0, -1)}` : "";
  const rootAsGiven =
    below === ""
      ? dir
      : dir.endsWith(below)
        ? dir.slice(0, -below.length)
        : root;
  const answer = { kind: "checkout" as const, root, rootAsGiven };
  knownRoots.add(root);
  memo.set(dir, answer);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return answer;
}

/**
 * Throw unless `root` is a checkout's toplevel — the status value reads git
 * nowhere else.
 */
export async function assertCheckoutRoot(root: string): Promise<void> {
  if (knownRoots.has(root)) return;
  if (await isEnterableDir(root)) {
    const top = (await runGit(["rev-parse", "--show-toplevel"], root)).trim();
    if (top === root) {
      knownRoots.add(root);
      return;
    }
  }
  throw new Error(`${root} is not the toplevel of a git checkout`);
}

/** Which checkout holds a folder, measured on every mount (see the declaration). */
export const gitCheckoutServed = serveValue(fileExplorerGitCheckoutValue, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "a folder's checkout changes only when a repository is created or removed around it, which nothing signals; asked again on every mount",
    },
  },
  loader: ({ path }) => {
    if (!path.startsWith("/")) {
      throw fileExplorerGitCheckoutValue.refuse(
        "invalid-path",
        `Not an absolute path: ${path}`,
      );
    }
    return resolveCheckout(path);
  },
});
