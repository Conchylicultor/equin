import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { OutboxCode } from "../../core";

/** Same generosity as the writer's merge-base read — see merge-base.ts. */
const DIFF_TIMEOUT_MS = 30_000;

/** Whether an entry's code still stands on main as its writer saw it. */
export type StalenessVerdict =
  /** Main has not touched the entry's files since its branch point: file it. */
  | { kind: "current" }
  /** Main changed these of the entry's files since its branch point: drop it. */
  | { kind: "stale"; changed: string[] }
  /**
   * The branch point is not a commit of this repository, so there is nothing
   * to diff. Main's history never loses a commit and every worktree shares
   * main's refs, so it was read in ANOTHER repository — what that means is the
   * drain's call, which knows whether the writer said so (`writer.repo`).
   */
  | { kind: "unknown-commit" };

/**
 * The staleness rule: has main changed any of `code.paths` between the writer's
 * merge-base and main's tip?
 *
 * - **No** — the code the report is about still exists on main as written, so
 *   the report is filed. That includes a problem the writer's OWN branch
 *   introduced (its change is not on main, so main's copy of those files did
 *   not move): exactly the regression a report should name.
 * - **Yes** — main may already have fixed it, so the report is dropped.
 *
 * Only a FIX made inside the named files is seen. One made elsewhere still lets
 * an older branch file, until that branch rebases — the rule errs toward
 * reporting, never toward silence.
 *
 * A merge-base this repository does not have is answered as `unknown-commit`,
 * decided before the diff, rather than thrown: it is a fact about the entry,
 * and the drain decides what it means.
 *
 * `--name-only` rather than `--quiet`: the same question, and the answer names
 * the files a drop is logged with. Any other failure — a git error, a timeout —
 * THROWS: "cannot tell" is never evidence for either verdict.
 */
export async function checkStaleness(
  code: OutboxCode,
  repo: { root: string; mainRef: string },
): Promise<StalenessVerdict> {
  // No paths name no code: nothing to compare. (An empty pathspec would diff
  // the whole tree, and drop nearly everything.)
  if (code.paths.length === 0) return { kind: "current" };
  if (!(await hasObject(code.mergeBase, repo.root)))
    return { kind: "unknown-commit" };
  const argv = [
    "git",
    "diff",
    "--name-only",
    code.mergeBase,
    repo.mainRef,
    "--",
    ...code.paths,
  ];
  const result = await spawnCaptured(argv, {
    cwd: repo.root,
    timeoutMs: DIFF_TIMEOUT_MS,
  });
  if (result.timedOut) {
    throw new Error(
      `staleness check timed out after ${DIFF_TIMEOUT_MS} ms: ${argv.join(" ")}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `staleness check failed (exit ${result.exitCode}): ${argv.join(" ")}\n${result.stderr.trim()}`,
    );
  }
  const changed = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return changed.length === 0
    ? { kind: "current" }
    : { kind: "stale", changed };
}

/**
 * Whether `repo` holds object `sha`: `git cat-file -e` exits 0 when it does and
 * 1 — silently — when it does not. Anything else is a git failure, and throws.
 */
async function hasObject(sha: string, root: string): Promise<boolean> {
  const argv = ["git", "cat-file", "-e", sha];
  const result = await spawnCaptured(argv, {
    cwd: root,
    timeoutMs: DIFF_TIMEOUT_MS,
  });
  if (result.timedOut) {
    throw new Error(
      `staleness check timed out after ${DIFF_TIMEOUT_MS} ms: ${argv.join(" ")}`,
    );
  }
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1 && result.stderr.trim() === "") return false;
  throw new Error(
    `staleness check failed (exit ${result.exitCode}): ${argv.join(" ")}\n${result.stderr.trim()}`,
  );
}
