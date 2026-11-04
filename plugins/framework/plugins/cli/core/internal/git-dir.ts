import {
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Absolute path to this checkout's git dir, resolved WITHOUT spawning git.
 *
 * Inside a worktree `.git` is a *gitfile* (`gitdir: /abs/path`), not a
 * directory, so `join(root, ".git")` is wrong there — the same reason the merge
 * driver shell scripts call `git rev-parse --git-dir`. This is the fs-only twin
 * of that call, so a check (which must stay cheap and side-effect-free) can read
 * git-dir state without a subprocess.
 *
 * Throws if `.git` is missing or a gitfile is unparseable: a caller asking for
 * the git dir of a non-repo has a broken assumption, not an empty result.
 */
export function resolveGitDir(root: string): string {
  const dotGit = join(root, ".git");
  const st = statSync(dotGit);
  if (st.isDirectory()) return dotGit;

  const contents = readFileSync(dotGit, "utf8");
  const match = /^gitdir:\s*(.+)$/m.exec(contents);
  if (!match) {
    throw new Error(
      `${dotGit} is a gitfile but has no "gitdir:" line — cannot resolve the git dir.`,
    );
  }
  const target = match[1]!.trim();
  return isAbsolute(target) ? target : resolve(root, target);
}
