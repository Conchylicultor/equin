import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { dropRetiredBranchReflogsIn } from "./retired-reflogs";

// Every test runs against a throwaway repository — never the real checkout.
let base: string;
let repo: AppPath;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnCaptured([GIT, "-C", cwd, ...args], {
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function hasReflog(ref: string): Promise<boolean> {
  const r = await spawnCaptured([GIT, "-C", repo, "reflog", "exists", ref], {
    timeoutMs: 60_000,
  });
  return r.exitCode === 0;
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "retired-reflogs-")));
  repo = asAppPath(join(base, "repo"));
  await git(base, "init", "-q", "-b", "main", repo);
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a");
  await git(repo, "add", "a.txt");
  await git(repo, "commit", "-q", "-m", "a");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test("drops only merged attempt reflogs no worktree has checked out; every ref stays", async () => {
  // Merged, checked out nowhere: retired (with its remote-tracking ref).
  await git(repo, "branch", "claude-web/att-done");
  await git(
    repo,
    "update-ref",
    "-m",
    "push",
    "refs/remotes/origin/claude-web/att-done",
    "main",
  );
  // Merged but checked out in a live worktree: kept, remote-tracking ref too.
  await git(repo, "branch", "claude-web/att-live");
  await git(
    repo,
    "update-ref",
    "-m",
    "push",
    "refs/remotes/origin/claude-web/att-live",
    "main",
  );
  await git(
    repo,
    "worktree",
    "add",
    "-q",
    join(base, "live"),
    "claude-web/att-live",
  );
  // Not in main: its reflog may hold the only trace of a draft — kept.
  await git(repo, "branch", "claude-web/att-open");
  writeFileSync(join(repo, "b.txt"), "b");
  await git(repo, "add", "b.txt");
  await git(repo, "commit", "-q", "-m", "b");
  await git(
    repo,
    "update-ref",
    "-m",
    "draft",
    "refs/heads/claude-web/att-open",
    "HEAD",
  );
  await git(repo, "reset", "-q", "--hard", "HEAD~1");
  // Outside the attempt namespace: not ours to touch.
  await git(repo, "branch", "other");

  expect(await dropRetiredBranchReflogsIn(repo)).toEqual({
    attemptReflogs: 5,
    dropped: 2,
  });

  expect(await hasReflog("refs/heads/claude-web/att-done")).toBe(false);
  expect(await hasReflog("refs/remotes/origin/claude-web/att-done")).toBe(
    false,
  );
  for (const kept of [
    "refs/heads/claude-web/att-live",
    "refs/remotes/origin/claude-web/att-live",
    "refs/heads/claude-web/att-open",
    "refs/heads/other",
    "refs/heads/main",
  ])
    expect(await hasReflog(kept)).toBe(true);
  // The refs themselves are untouched.
  await git(repo, "rev-parse", "--verify", "refs/heads/claude-web/att-done");
  await git(
    repo,
    "rev-parse",
    "--verify",
    "refs/remotes/origin/claude-web/att-done",
  );

  // Idempotent: nothing left to drop.
  expect(await dropRetiredBranchReflogsIn(repo)).toEqual({
    attemptReflogs: 3,
    dropped: 0,
  });
});
