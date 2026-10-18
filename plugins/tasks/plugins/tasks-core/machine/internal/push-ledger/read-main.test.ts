/**
 * `readMainCommits`, against real throwaway repositories. The behaviours pinned
 * here are the ones the ledger's correctness rests on, so each is REPRODUCED with
 * actual git commands rather than asserted about:
 *
 *   - only trailer-bearing commits become ledger rows (a `--from-main` push has
 *     nothing to attribute);
 *   - `since` genuinely bounds the walk, which is what lets the re-derivation sit
 *     on the read path instead of in a deferred warm-up;
 *   - a git failure THROWS. Resolving to an empty list would be exactly the
 *     absorbable emptiness this design removes: "nothing landed" and "the read
 *     failed" must never be the same value.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { readMainCommits } from "./read-main";

// Wedge-breaker for this suite's fixture git commands. A test that hangs takes
// the whole runner with it and reports nothing, so the bound is what turns that
// into a named failure; thirty seconds is orders of magnitude above what any of
// these throwaway-repo commands take.
const GIT_TIMEOUT_MS = 30_000;

// The machine's own git config must not reach these repos: a global
// `core.hooksPath` (this repo installs one) or a signing key would change what
// `git commit` produces.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await spawnExpectOk([GIT, ...args], {
    cwd,
    env: GIT_ENV,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return res.stdout;
}

let fileSeq = 0;

async function commit(
  repo: string,
  subject: string,
  trailers?: { conv: string; push: string },
  when?: string,
): Promise<void> {
  fileSeq += 1;
  writeFileSync(join(repo, `f${fileSeq}.txt`), `${subject}\n`);
  await git(repo, "add", "-A");
  const args = ["commit", "-m", subject];
  // The trailers go in their own final paragraph, exactly as
  // `.githooks/prepare-commit-msg` + the push CLI's `--exec` leave them.
  if (trailers) {
    args.push(
      "-m",
      `Singularity-Conversation: ${trailers.conv}\nSingularity-Push: ${trailers.push}`,
    );
  }
  await spawnExpectOk([GIT, ...args], {
    cwd: repo,
    env: when ? { ...GIT_ENV, GIT_COMMITTER_DATE: when } : GIT_ENV,
    timeoutMs: GIT_TIMEOUT_MS,
  });
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sg-push-ledger-"));
  const repo = join(root, "repo");
  try {
    await git(root, "init", "--initial-branch=main", "repo");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Push Ledger Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await commit(repo, "base");
    await fn(repo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("reads a trailer-bearing commit, newest first", async () => {
  await withRepo(async (repo) => {
    await commit(repo, "first", { conv: "conv-1", push: "push-a" });
    await commit(repo, "second", { conv: "conv-1", push: "push-b" });

    const commits = await readMainCommits(repo, null);

    expect(commits.map((c) => c.subject)).toEqual(["second", "first"]);
    expect(commits[0]?.conversationId).toBe("conv-1");
    expect(commits[0]?.pushId).toBe("push-b");
  });
});

// A `--from-main` push carries no conversation trailer, so nothing can attach it
// to an attempt. It must not appear at all rather than appear unattributed.
test("skips a commit that carries no trailers", async () => {
  await withRepo(async (repo) => {
    await commit(repo, "untrailered");
    await commit(repo, "trailered", { conv: "conv-1", push: "push-a" });

    const commits = await readMainCommits(repo, null);

    expect(commits.map((c) => c.subject)).toEqual(["trailered"]);
  });
});

// The bound is what makes the re-derivation cheap enough to be on the read path.
test("`since` bounds the walk to recent commits", async () => {
  await withRepo(async (repo) => {
    await commit(
      repo,
      "ancient",
      { conv: "conv-1", push: "push-old" },
      "2026-01-01T00:00:00Z",
    );
    await commit(
      repo,
      "recent",
      { conv: "conv-1", push: "push-new" },
      "2026-08-17T00:00:00Z",
    );

    const all = await readMainCommits(repo, null);
    const bounded = await readMainCommits(
      repo,
      new Date("2026-06-01T00:00:00Z"),
    );

    expect(all.map((c) => c.subject)).toEqual(["recent", "ancient"]);
    expect(bounded.map((c) => c.subject)).toEqual(["recent"]);
  });
});

test("a repo with no trailer-bearing commits reads as empty, not as a failure", async () => {
  await withRepo(async (repo) => {
    expect(await readMainCommits(repo, null)).toEqual([]);
  });
});

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so this asserts
 * the rejection for real and hands back the error to inspect.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

test("an unreadable repo THROWS rather than resolving to no commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "sg-push-ledger-nogit-"));
  try {
    const err = await rejection(readMainCommits(root, null));
    expect(err).toBeInstanceOf(Error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
