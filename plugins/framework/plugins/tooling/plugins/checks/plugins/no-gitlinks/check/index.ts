import {
  getWorktreeRoot,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import type { Check } from "@plugins/framework/plugins/tooling/core";

// Wedge-breaker for a metadata-only git read: far above any real duration,
// because starvation under a saturated check run is what these suffer, not
// slowness. Same bound as the sibling git-reading checks.
const GIT_TIMEOUT_MS = 60_000;

// The index mode git gives a directory it records as "a commit of another
// repository" rather than as content.
const GITLINK_MODE = "160000";

async function gitRecords(root: string, args: string[]): Promise<string[]> {
  const result = await spawnExpectOk(["git", ...args, "-z"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result.stdout.split("\0").filter((record) => record.length > 0);
}

/** Paths the index records as gitlinks. Each record is `<mode> <sha> <stage>\t<path>`. */
async function trackedGitlinks(root: string): Promise<string[]> {
  const records = await gitRecords(root, ["ls-files", "--stage"]);
  return records
    .filter((record) => record.startsWith(`${GITLINK_MODE} `))
    .map((record) => record.slice(record.indexOf("\t") + 1));
}

/**
 * Untracked, un-ignored directories that hold their own repository — a clone,
 * a `git init`, or a `git worktree add` target. Without `--directory`,
 * `ls-files --others` descends into ordinary untracked directories and lists
 * their files; the only entry it prints as `dir/` is one it refuses to descend
 * into because it is a repository. That is exactly the set `git add -A` (the
 * staging step of `./equin push -m`) would record as gitlinks.
 */
async function nestedCheckouts(root: string): Promise<string[]> {
  const records = await gitRecords(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return records
    .filter((path) => path.endsWith("/"))
    .map((path) => path.slice(0, -1));
}

function bulleted(paths: string[]): string {
  return paths.map((path) => `  ${path}`).join("\n");
}

const WHY =
  "This repo has no submodules, so a gitlink is always a checkout swept in by accident: " +
  "`git submodule` commands fail on it, git-based file listings show a directory as a file, " +
  "and every checkout of main grows an empty directory at that path.";

/**
 * The repo commits content, never a pointer to another repository. A gitlink
 * (index mode 160000) is what `git add -A` records for any directory holding
 * its own `.git` — which is how a Claude Code worktree checkout under
 * `.claude/worktrees/` landed on main in April 2026 and stayed there five
 * months (`.gitignore` does not apply to an already-tracked path). See
 * `research/2026-09-10-global-stray-worktree-gitlink.md`.
 */
const check: Check = {
  id: "no-gitlinks",
  description:
    "no gitlink (a nested repository or worktree checkout) is tracked, or would be swept in by `git add -A`",
  // Reads the real index, which the runner's tree hash (a scratch `add -A`)
  // does not reproduce exactly: an index gitlink whose directory is gone drops
  // out of the scratch tree. Two metadata reads — nothing worth caching.
  cacheSignature: () => null,
  async run() {
    const root = await getWorktreeRoot();

    const tracked = await trackedGitlinks(root);
    if (tracked.length > 0) {
      return {
        ok: false,
        message:
          `The index tracks ${tracked.length} gitlink(s) — directories recorded as a commit of another repository:\n` +
          `${bulleted(tracked)}\n${WHY}`,
        hint:
          `Untrack them (the files on disk are left alone): ` +
          `git rm --cached ${tracked.join(" ")} — then push again. ` +
          "If the directory is a checkout that should never be committed, also make sure its path is gitignored.",
      };
    }

    const nested = await nestedCheckouts(root);
    if (nested.length > 0) {
      return {
        ok: false,
        message:
          `${nested.length} untracked directory(ies) hold their own git repository, and \`./equin push -m\` ` +
          `(which stages with \`git add -A\`) would commit each as a gitlink:\n${bulleted(nested)}\n${WHY}`,
        hint:
          "Move the checkout outside the repo (agent worktrees belong under `.claude/worktrees/`, which is gitignored), " +
          "or add its path to `.gitignore`.",
      };
    }

    return { ok: true };
  },
};

export default check;
