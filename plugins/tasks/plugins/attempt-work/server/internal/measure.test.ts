/**
 * The git measurement, against real throwaway repositories. These are the
 * load-bearing behaviours of the whole plugin, so they are REPRODUCED here rather
 * than asserted about: each test builds the history it describes with actual git
 * commands and then measures it.
 *
 * The first test is the D1 reproduction — the shape that made `main`'s UI offer
 * *Drop & Close* over merged work: a branch whose commits were rebased onto `main`
 * and fast-forwarded is `ahead: 0`, indistinguishable from an attempt that did
 * nothing unless the landed commits are counted from their trailers.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import {
  GitError,
  WorktreeGoneError,
} from "@plugins/primitives/plugins/commit-list/server";
import { standingOf } from "../../core/standing";
import type { AttemptPending } from "../../core/protocol";
import {
  probeHeadMain,
  readLanded,
  readPendingFromBranchRef,
  readPendingInWorktree,
  refExists,
} from "./measure";

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

interface Trailers {
  conv: string;
  push: string;
}

let fileSeq = 0;

async function commit(
  repo: string,
  subject: string,
  trailers?: Trailers,
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
  await git(repo, ...args);
}

/** A fresh repo with `main` and one trailer-less base commit. */
async function withRepo(
  fn: (repo: string, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sg-attempt-work-"));
  const repo = join(root, "repo");
  try {
    await git(root, "init", "--initial-branch=main", "repo");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Attempt Work Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await commit(repo, "base");
    await fn(repo, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so this asserts
 * the rejection for real and hands back the error to pin its class.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

function standing(
  pending: AttemptPending,
  landed: { shas: string[]; pushIds: string[] },
): string {
  return standingOf({
    pending,
    landedCommits: landed.shas.length,
    landedPushes: landed.pushIds.length,
    ledgerPushes: 0,
    delivered: false,
  });
}

const ALL_TIME = new Date(0);

test("D1: a rebased-and-fast-forwarded branch is ahead 0 yet reads as landed", async () => {
  await withRepo(async (repo) => {
    await git(repo, "checkout", "-b", "claude-web/att-1", "main");
    await commit(repo, "attempt work", { conv: "conv-1", push: "push-1" });
    // `main` moves under the attempt, so the push genuinely has to rebase — this
    // is what rewrites the shas and makes the ledger the only other record.
    await git(repo, "checkout", "main");
    await commit(repo, "another agent's work", {
      conv: "conv-other",
      push: "push-other",
    });
    await git(repo, "checkout", "claude-web/att-1");
    await git(repo, "rebase", "main");
    await git(repo, "checkout", "main");
    await git(repo, "merge", "--ff-only", "claude-web/att-1");
    // The attempt's own worktree still sits on its branch.
    await git(repo, "checkout", "claude-web/att-1");

    const pending = await readPendingInWorktree(repo);
    expect(pending).toMatchObject({ kind: "measured", ahead: 0, behind: 0 });

    const landed = await readLanded(repo, new Set(["conv-1"]), ALL_TIME);
    expect(landed.shas).toHaveLength(1);
    expect(landed.pushIds).toEqual(["push-1"]);
    // The whole point: nothing here reads as "this attempt has nothing at stake".
    expect(standing(pending, landed)).toBe("landed");
  });
});

test("the landed grep is scoped to the attempt's own conversations", async () => {
  await withRepo(async (repo) => {
    await commit(repo, "mine", { conv: "conv-mine", push: "push-mine" });
    await commit(repo, "theirs", { conv: "conv-theirs", push: "push-theirs" });
    await commit(repo, "untrailered");

    expect(
      (await readLanded(repo, new Set(["conv-mine"]), ALL_TIME)).shas,
    ).toHaveLength(1);
    expect(
      (await readLanded(repo, new Set(["conv-mine", "conv-theirs"]), ALL_TIME))
        .shas,
    ).toHaveLength(2);
    expect(
      (await readLanded(repo, new Set(["conv-nobody"]), ALL_TIME)).shas,
    ).toHaveLength(0);
    // No conversations at all: nothing can match, and no git runs.
    expect(await readLanded(repo, new Set(), ALL_TIME)).toEqual({
      shas: [],
      pushIds: [],
    });
  });
});

test("one push across several commits counts as one push", async () => {
  await withRepo(async (repo) => {
    await commit(repo, "first", { conv: "conv-1", push: "push-1" });
    await commit(repo, "second", { conv: "conv-1", push: "push-1" });
    await commit(repo, "third", { conv: "conv-1", push: "push-2" });
    const landed = await readLanded(repo, new Set(["conv-1"]), ALL_TIME);
    expect(landed.shas).toHaveLength(3);
    expect([...landed.pushIds].sort()).toEqual(["push-1", "push-2"]);
  });
});

test("D2: local commits on a clean worktree read ahead > 0", async () => {
  await withRepo(async (repo) => {
    await git(repo, "checkout", "-b", "claude-web/att-2", "main");
    await commit(repo, "committed, never pushed", {
      conv: "conv-2",
      push: "push-2",
    });
    expect(await git(repo, "status", "--porcelain")).toBe("");

    const pending = await readPendingInWorktree(repo);
    expect(pending).toMatchObject({
      kind: "measured",
      ahead: 1,
      behind: 0,
      branch: "claude-web/att-2",
    });
    // Nothing landed (this repo's `main` never took the commit), yet the standing
    // is still not "none" — the drop must not be offered.
    const landed = await readLanded(repo, new Set(["conv-2"]), ALL_TIME);
    expect(landed.shas).toHaveLength(0);
    expect(standing(pending, landed)).toBe("pending");
  });
});

test("a branch that never committed reads ahead 0 with nothing landed", async () => {
  await withRepo(async (repo) => {
    await git(repo, "checkout", "-b", "claude-web/att-3", "main");
    const pending = await readPendingInWorktree(repo);
    expect(pending).toMatchObject({ kind: "measured", ahead: 0, behind: 0 });
    const landed = await readLanded(repo, new Set(["conv-3"]), ALL_TIME);
    // The drop affordance survives: this attempt really has nothing at stake.
    expect(standing(pending, landed)).toBe("none");
  });
});

test("rebasing onto a newer main does not make main's commits this attempt's work", async () => {
  await withRepo(async (repo) => {
    await git(repo, "checkout", "-b", "claude-web/att-4", "main");
    await git(repo, "checkout", "main");
    await commit(repo, "another agent's work", {
      conv: "conv-other",
      push: "push-other",
    });
    await git(repo, "checkout", "claude-web/att-4");
    await git(repo, "rebase", "main");

    const pending = await readPendingInWorktree(repo);
    expect(pending).toMatchObject({ kind: "measured", ahead: 0, behind: 0 });
    const landed = await readLanded(repo, new Set(["conv-4"]), ALL_TIME);
    expect(landed.shas).toHaveLength(0);
    expect(standing(pending, landed)).toBe("none");
  });
});

test("a reaped worktree still measures its branch from the main repo", async () => {
  await withRepo(async (repo, root) => {
    const wt = join(root, "wt-att-5");
    await git(repo, "worktree", "add", "-b", "claude-web/att-5", wt, "main");
    await commit(wt, "work in the worktree", {
      conv: "conv-5",
      push: "push-5",
    });
    rmSync(wt, { recursive: true, force: true });

    // The directory is gone: a determinate state, and the git runner says so with
    // its own error class rather than a generic failure.
    expect(await rejection(readPendingInWorktree(wt))).toBeInstanceOf(
      WorktreeGoneError,
    );

    // `git worktree remove` does not delete the branch, so the commits are still
    // measurable — this is what keeps a reaped attempt's unpushed work visible.
    const pending = await readPendingFromBranchRef(
      repo,
      "refs/heads/claude-web/att-5",
    );
    expect(pending).toMatchObject({
      kind: "measured",
      ahead: 1,
      behind: 0,
      branch: "claude-web/att-5",
    });
    expect(standing(pending, { shas: [], pushIds: [] })).toBe("pending");
  });
});

test("a deleted branch is the determinate no-branch answer", async () => {
  await withRepo(async (repo) => {
    expect(await refExists(repo, "refs/heads/main")).toBe(true);
    expect(await refExists(repo, "refs/heads/claude-web/gone")).toBe(false);
    expect(
      await readPendingFromBranchRef(repo, "refs/heads/claude-web/gone"),
    ).toEqual({
      kind: "no-branch",
    });
  });
});

test("a git failure throws — it never resolves to a confident zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-attempt-work-norepo-"));
  try {
    // Not a repository (present, but no git): every read must fail loudly. An
    // absorbed `{ahead: 0}` / `[]` here is exactly what would offer the drop.
    expect(await rejection(refExists(dir, "refs/heads/main"))).toBeInstanceOf(
      GitError,
    );
    expect(
      await rejection(readPendingFromBranchRef(dir, "refs/heads/main")),
    ).toBeInstanceOf(GitError);
    expect(await rejection(readPendingInWorktree(dir))).toBeInstanceOf(
      GitError,
    );
    expect(
      await rejection(readLanded(dir, new Set(["conv-1"]), ALL_TIME)),
    ).toBeInstanceOf(GitError);
    expect(await rejection(probeHeadMain(dir))).toBeInstanceOf(GitError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeHeadMain reads both tips", async () => {
  await withRepo(async (repo) => {
    await git(repo, "checkout", "-b", "claude-web/att-6", "main");
    await commit(repo, "ahead of main", { conv: "conv-6", push: "push-6" });
    const { headSha, mainSha } = await probeHeadMain(repo);
    expect(headSha).toBe((await git(repo, "rev-parse", "HEAD")).trim());
    // `mainSha` may come from git-watcher's in-memory sha, so only its shape is
    // asserted here — the point is that neither read is ever an empty string.
    expect(mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(headSha).not.toBe(mainSha);
  });
});
