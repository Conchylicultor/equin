import { GIT } from "@plugins/infra/plugins/paths/server";
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import { DIRTY_WORKTREE_REASON } from "../../core";
import type { Staleness } from "../../core";

// Every git call in this file is a metadata read (`rev-parse`, `status`,
// `cat-file -e`, `merge-base`, `rev-list --count`) taken while a user is
// waiting: cutting a release, or opening a release's detail pane. The request is
// the deadline these serve, so a minute is far past the point where returning
// the answer still helps anyone, and only a wedge ever reaches it.
const GIT_TIMEOUT_MS = 60_000;

/** What source state a release was cut from. Both fields go into `RELEASE.json`. */
export interface GitProvenance {
  /** `git rev-parse HEAD` at the instant the release started. */
  commitSha: string;
  /**
   * `git status --porcelain` was non-empty — INCLUDING untracked files, because
   * vite builds untracked files into the dist, so an untracked file is part of
   * the artifact just as much as a modified tracked one.
   */
  commitDirty: boolean;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await spawnExpectOk(
    [GIT, "--no-optional-locks", "-C", cwd, ...args],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  return stdout;
}

/**
 * Read the source state a release is about to be cut from.
 *
 * Must be called BEFORE the artifact phase: the `build --hermetic` child it
 * shells into writes generated files into the checkout, so a dirty read taken
 * after it would report every release as dirty and say nothing about what the
 * human left in the tree.
 *
 * Throws (via `spawnExpectOk`) when git fails: a release runs from a full dev
 * checkout by construction, so "this is not a git repository" is a broken
 * premise, not a state to encode.
 */
export async function readGitProvenance(cwd: string): Promise<GitProvenance> {
  const commitSha = (await git(["rev-parse", "HEAD"], cwd)).trim();
  // `--untracked-files=normal` is git's default, spelled out so a repo- or
  // user-level `status.showUntrackedFiles=no` cannot silently make a dirty tree
  // read as clean.
  const status = await git(
    ["status", "--porcelain", "--untracked-files=normal"],
    cwd,
  );
  return { commitSha, commitDirty: status.trim().length > 0 };
}

/**
 * `git rev-parse HEAD` of `cwd` — the one git fact {@link compareToHead}'s
 * answer moves with (besides the bundle's own provenance), so it is what a
 * memo of that answer keys on. One cheap metadata read; throws when git fails.
 */
export async function readHeadSha(cwd: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], cwd)).trim();
}

/**
 * How a bundle's recorded provenance relates to this repository's `HEAD`.
 *
 * The rules, in the order they are applied:
 *
 * 1. **Dirty ⇒ always `unknown`.** The sha names the bundle's PARENT commit, not
 *    its bytes, so no comparison against it can prove anything. Never `current`.
 * 2. **No sha ⇒ `unknown`.** A bundle cut before provenance was recorded.
 * 3. **A sha this repo has never seen ⇒ `unknown`, not a throw.** A run dir can
 *    outlive the branch it was built from, or come from another clone.
 * 4. Ancestor of HEAD ⇒ `behind` with the true commit distance;
 *    otherwise ⇒ `diverged`.
 */
export async function compareToHead(
  provenance: { commitSha?: string | null; commitDirty?: boolean | null },
  cwd: string,
): Promise<Staleness> {
  if (provenance.commitDirty === true) {
    return { kind: "unknown", reason: DIRTY_WORKTREE_REASON };
  }
  const sha = provenance.commitSha;
  if (sha == null || sha.length === 0) {
    return {
      kind: "unknown",
      reason:
        "this release recorded no commit — it was cut before provenance existed",
    };
  }

  const known = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      cwd,
      "cat-file",
      "-e",
      `${sha}^{commit}`,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (known.exitCode !== 0) {
    return {
      kind: "unknown",
      reason: `commit ${sha} is not known to this repository`,
    };
  }

  const head = (await git(["rev-parse", "HEAD"], cwd)).trim();
  if (head === sha) return { kind: "current" };

  const isAncestor = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      cwd,
      "merge-base",
      "--is-ancestor",
      sha,
      "HEAD",
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (isAncestor.exitCode !== 0) return { kind: "diverged", sha };

  const count = (
    await git(["rev-list", "--count", `${sha}..HEAD`], cwd)
  ).trim();
  return { kind: "behind", commits: Number(count) };
}

/** A commit looked up by sha: its subject line, or why this repo cannot say. */
export type CommitLookup =
  | { readonly kind: "known"; readonly subject: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * `sha`'s subject line (`git log -1 --format=%s`), or `unknown` when this
 * repository has never seen the commit — the same rule 3 as
 * {@link compareToHead}: a run dir (or a deploy record) can outlive the branch
 * it was built from, or come from another clone. Any other git failure throws.
 */
export async function readCommitSubject(
  sha: string,
  cwd: string,
): Promise<CommitLookup> {
  const known = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      cwd,
      "cat-file",
      "-e",
      `${sha}^{commit}`,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (known.exitCode !== 0) {
    return {
      kind: "unknown",
      reason: `commit ${sha} is not known to this repository`,
    };
  }
  const subject = await git(["log", "-1", "--format=%s", sha], cwd);
  return { kind: "known", subject: subject.replace(/\n$/, "") };
}

/** The sha `ref` points at (`git rev-parse --verify <ref>^{commit}`). Throws when it does not resolve. */
export async function readRefSha(ref: string, cwd: string): Promise<string> {
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd)).trim();
}

/**
 * How many commits reachable from `ref` are not reachable from `sha`
 * (`git rev-list --count <sha>..<ref>`) — "how far behind `ref` is `sha`",
 * counted the same way whether `sha` is an ancestor of it or diverged from it.
 * Throws when git fails or answers something that is not a count.
 */
export async function countCommitsBehind(
  sha: string,
  ref: string,
  cwd: string,
): Promise<number> {
  const out = (
    await git(["rev-list", "--count", `${sha}..${ref}`], cwd)
  ).trim();
  const count = Number(out);
  if (!/^\d+$/.test(out) || !Number.isSafeInteger(count)) {
    throw new Error(
      `git rev-list --count ${sha}..${ref} printed ${JSON.stringify(out)}, which is not a commit count`,
    );
  }
  return count;
}
