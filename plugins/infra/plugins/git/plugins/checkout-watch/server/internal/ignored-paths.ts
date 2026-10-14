import {
  GitError,
  tryRunGit,
  WorktreeGoneError,
} from "@plugins/primitives/plugins/commit-list/server";

/**
 * Which of `relPaths` git ignores, by git's own rules (every `.gitignore`,
 * `info/exclude`, `core.excludesFile`) — never a second matcher that could
 * drift from them. Without `--no-index` a tracked path is never reported, so a
 * change to a tracked file matching an ignore pattern is kept, as `git status`
 * shows it; a path inside an ignored folder is reported whether or not it
 * still exists. Exit 1 is git's "none of them". A checkout reaped while
 * watched ignores nothing: its readers hear the removal.
 */
export async function ignoredPaths(
  root: string,
  relPaths: readonly string[],
): Promise<ReadonlySet<string>> {
  const args = ["check-ignore", "-z", "--stdin"];
  try {
    const result = await tryRunGit(args, root, {
      stdin: relPaths.map((p) => `${p}\0`).join(""),
    });
    if (result.ok) return new Set(result.stdout.split("\0").filter(Boolean));
    if (result.exitCode === 1) return new Set();
    throw new GitError({
      args,
      cwd: root,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  } catch (err) {
    if (err instanceof WorktreeGoneError) return new Set();
    throw err;
  }
}
