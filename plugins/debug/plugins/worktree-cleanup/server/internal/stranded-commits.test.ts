import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  classifyAttempt,
  classifyMintedCheckout,
  type AttemptFacts,
} from "./reap-policy";
import { getGitHygiene, SAFE_REAP_AGE_MS } from "./safety";

// What a reap can and cannot lose, against a real repo: removing a checkout
// (its dir moved away, then `git worktree prune` — removeWorktree's two git
// steps) leaves every BRANCH standing, so a branch's unmerged commits survive;
// a commit only a detached HEAD reaches does not. The hygiene probe must tell
// the two apart, and the second must keep the checkout off every clean path.
const root = mkdtempSync(join(tmpdir(), "stranded-commits-"));
const repo = join(root, "repo");
const trash = join(root, "trash");
const previousDir = readEnv("DIR");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function commitIn(wt: string, file: string): string {
  writeFileSync(join(wt, file), `${file}\n`);
  git(wt, "add", file);
  git(wt, "commit", "-q", "-m", file);
  return git(wt, "rev-parse", "HEAD");
}

// removeWorktree's git half: the dir leaves (renamed into a trash dir), then
// prune drops the registration — and with it the checkout's HEAD and reflog.
function removeCheckout(wt: string, name: string): void {
  renameSync(wt, join(trash, name));
  git(repo, "worktree", "prune");
}

// Whether any ref (every worktree's HEAD included) still reaches `sha`.
function reachable(sha: string): boolean {
  return git(repo, "rev-list", "--all").split("\n").includes(sha);
}

beforeAll(() => {
  setEnv("DIR", join(root, "data"));
  execFileSync("mkdir", ["-p", repo, trash]);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  commitIn(repo, "init.txt");
});

afterAll(() => {
  if (previousDir === undefined) unsetEnv("DIR");
  else setEnv("DIR", previousDir);
  rmSync(root, { recursive: true, force: true });
});

const old: AttemptFacts = {
  id: "att-1793894197-y14qgx",
  worktreePath: "",
  retained: false,
  createdAt: new Date(Date.now() - SAFE_REAP_AGE_MS),
};
const finished = { hasDir: true, hasDB: false, hasRegistry: false };

describe("a reaped checkout's commits", () => {
  // The case task-1793894005-zs3h8v asked about: `./equin push` committed on
  // the attempt branch and the merge into main failed.
  test("commits on the branch, not on main: reapable, and they survive", async () => {
    const name = "att-1793894197-aaaaaa";
    const wt = join(root, name);
    git(repo, "worktree", "add", "-q", "-b", `claude-web/${name}`, wt);
    const sha = commitIn(wt, "pushed-but-not-merged.txt");

    const hygiene = await getGitHygiene(wt);
    expect(hygiene).toEqual({ isDirty: false });
    expect(
      classifyAttempt(
        { ...old, worktreePath: wt },
        { ...finished, taskStatus: "done", now: Date.now(), hygiene },
      ),
    ).not.toBeNull();

    removeCheckout(wt, name);
    expect(git(repo, "rev-parse", `refs/heads/claude-web/${name}`)).toBe(sha);
    expect(reachable(sha)).toBe(true);
  });

  test("a detached HEAD at a branch's commit holds nothing of its own", async () => {
    const name = "att-1793894197-bbbbbb";
    const wt = join(root, name);
    git(repo, "worktree", "add", "-q", "--detach", wt, "main");
    expect(await getGitHygiene(wt)).toEqual({ isDirty: false });
  });

  test("a commit only a detached HEAD reaches: kept on every clean path", async () => {
    const name = "att-1793894197-cccccc";
    const wt = join(root, name);
    git(repo, "worktree", "add", "-q", "--detach", wt, "main");
    const sha = commitIn(wt, "committed-on-detached-head.txt");

    const hygiene = await getGitHygiene(wt);
    expect(hygiene).toEqual({ isDirty: true, strandedCommit: sha });
    expect(
      classifyAttempt(
        { ...old, worktreePath: wt },
        { ...finished, taskStatus: "done", now: Date.now(), hygiene },
      ),
    ).toBeNull();
    expect(
      classifyMintedCheckout(
        { name, path: wt },
        { kind: "stamped", minter: asNamespace("att-1793668451-09c9rz") },
        {
          minterDirExists: false,
          minterRetained: false,
          ageMs: SAFE_REAP_AGE_MS,
          hygiene,
        },
      ),
    ).toBeNull();

    // Why: had it been reaped, nothing would reach the commit any more.
    expect(reachable(sha)).toBe(true);
    removeCheckout(wt, name);
    expect(reachable(sha)).toBe(false);
  });

  test("a commit only a per-worktree ref holds: kept", async () => {
    const name = "att-1793894197-dddddd";
    const wt = join(root, name);
    git(repo, "worktree", "add", "-q", "--detach", wt, "main");
    const sha = commitIn(wt, "kept-by-refs-worktree.txt");
    git(wt, "update-ref", "refs/worktree/keep", sha);
    git(wt, "checkout", "-q", "--detach", "main");

    expect(await getGitHygiene(wt)).toEqual({
      isDirty: true,
      strandedCommit: sha,
    });
  });
});
