import { stat } from "node:fs/promises";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// One bound for every git invocation routed through this file — which is the
// point of the file, so a per-call number would just be a knob nobody could set
// meaningfully. These are local reads (`log`, `rev-parse`, `merge-base`,
// `diff`) over one worktree, served to an open request or a live resource
// recompute, and a minute is well past the point where the answer still helps
// anyone. It exists to break a wedge — including the specific one this repo has
// seen twice, a git child hung against a checkout being mutated underneath it.
const GIT_TIMEOUT_MS = 60_000;

/**
 * Thrown by {@link runGit} when a git invocation exits non-zero. Carries the
 * full context (args, cwd, exit code, captured stderr) so the failure is
 * debuggable rather than an absorbable `null`.
 */
export class GitError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stderr: string;

  constructor(opts: {
    args: string[];
    cwd: string;
    exitCode: number;
    stderr: string;
  }) {
    super(
      `git ${opts.args.join(" ")} (cwd: ${opts.cwd}) exited ${opts.exitCode}: ${opts.stderr.trim()}`,
    );
    this.name = "GitError";
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}

/**
 * The git invocation's `cwd` does not exist. Distinct from a plain
 * {@link GitError} because a vanished worktree is a determinate *state* — the
 * directory was reaped by worktree-cleanup, or removed by hand — not a failed
 * read. A `worktreePath` held in the DB (e.g. `attempts.worktreePath`) is a
 * claim about a directory that outlives it, so every consumer that may hold a
 * stale path can branch on this type instead of string-matching git's stderr.
 *
 * Thrown by BOTH {@link runGit} and {@link tryRunGit}: an absent cwd is never a
 * legitimate exit-code answer, only a broken premise.
 */
export class WorktreeGoneError extends GitError {
  constructor(opts: {
    args: string[];
    cwd: string;
    exitCode: number;
    stderr: string;
  }) {
    super(opts);
    this.name = "WorktreeGoneError";
  }
}

/**
 * Classifies a failed invocation: did git fail because its `cwd` is gone?
 * Answered by `stat`, not by parsing git's stderr, and only ever on the failure
 * path — the success path pays nothing.
 */
async function cwdIsGone(cwd: string): Promise<boolean> {
  try {
    await stat(cwd);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw err;
  }
}

/**
 * Discriminated result of a git invocation. Use {@link tryRunGit} (over
 * {@link runGit}) only when a non-zero exit is a legitimate answer the caller
 * must branch on — e.g. probing whether a ref exists, `git merge-base` exiting
 * 1 for "no common ancestor", or an exit-code-as-signal command like
 * `git diff --no-index` / `--exit-code` (exit 1 = "differs", with the diff on
 * stdout). Everywhere else, prefer `runGit` and let the throw propagate.
 *
 * `stdout` is present on BOTH variants: the exit-code-as-signal commands emit
 * their payload on stdout while exiting non-zero, so dropping stdout on failure
 * would force those callers back into ad-hoc local git spawns. `stderr` is
 * carried on the failure variant so {@link runGit}'s thrown {@link GitError}
 * message stays debuggable.
 */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; exitCode: number; stdout: string; stderr: string };

/** What a git invocation is fed besides its args. */
export interface GitRunOptions {
  /** Written to git's stdin whole (a `--stdin` command's input). */
  stdin?: string;
}

/**
 * Probe variant: runs git and returns a discriminated result, never throwing
 * on a non-zero exit. The caller inspects `.ok` and branches.
 *
 * One exception: a non-zero exit whose `cwd` no longer exists throws
 * {@link WorktreeGoneError}. A probe answers a question *about a repository*;
 * with no repository there is no answer, and returning `ok:false` would let a
 * caller absorb a reaped worktree as a legitimate negative (`rev-parse <sha>^`
 * exiting non-zero would read as "root commit", not "the worktree is gone").
 */
export async function tryRunGit(
  args: string[],
  cwd: string,
  opts: GitRunOptions = {},
): Promise<GitResult> {
  const result = await spawnCaptured(
    [GIT, "--no-optional-locks", "-C", cwd, ...args],
    { timeoutMs: GIT_TIMEOUT_MS, stdin: opts.stdin },
  );
  const { exitCode, stdout, stderr } = result;
  if (exitCode === 0) return { ok: true, stdout };
  // A KILLED child is not an answer, so it must not become one. Every caller of
  // the probe variant reads `ok: false` as git's verdict — "no such ref", "no
  // common ancestor", "they differ" — and a timeout reported that way would be
  // the absorbed failure this file's two error types exist to prevent.
  if (result.timedOut) {
    throw new GitError({
      args,
      cwd,
      exitCode,
      stderr: `git did not finish within ${GIT_TIMEOUT_MS} ms and was killed`,
    });
  }
  if (await cwdIsGone(cwd)) {
    throw new WorktreeGoneError({ args, cwd, exitCode, stderr });
  }
  return { ok: false, exitCode, stdout, stderr };
}

/**
 * Runs git and returns stdout, throwing {@link GitError} on any non-zero exit —
 * or the narrower {@link WorktreeGoneError} when `cwd` itself has vanished.
 * This is the default: a git failure is never conflated with an empty/absent
 * result. Reach for {@link tryRunGit} only for genuine probe semantics.
 */
export async function runGit(
  args: string[],
  cwd: string,
  opts: GitRunOptions = {},
): Promise<string> {
  const result = await tryRunGit(args, cwd, opts);
  if (!result.ok) {
    throw new GitError({
      args,
      cwd,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result.stdout;
}
