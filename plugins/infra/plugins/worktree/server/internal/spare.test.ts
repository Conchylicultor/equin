import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { createSpareIn, pruneSparesIn } from "./spare";
import {
  checkoutAttempt,
  convergeExistingCheckout,
  gitWorktreesDir,
  isUnfinishedSpareClaim,
  listReadySpares,
  listWorktreeEntries,
} from "./worktree";

// Every test runs against a throwaway repository — never the real checkout.
let base: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnCaptured([GIT, "-C", cwd, ...args], {
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function commit(file: string, content: string): Promise<string> {
  writeFileSync(join(repo, file), content);
  await git(repo, "add", file);
  await git(repo, "commit", "-q", "-m", `write ${file}`);
  return git(repo, "rev-parse", "HEAD");
}

const wtFor = (id: string) => join(gitWorktreesDir(repo), id);
const noGate = <T>(fn: () => Promise<T>) => fn();

async function lockOf(path: string): Promise<string | null | undefined> {
  return (await listWorktreeEntries(repo)).find((e) => e.path === path)?.locked;
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "spare-test-")));
  repo = join(base, "repo");
  const init = await spawnCaptured([GIT, "init", "-q", "-b", "main", repo], {
    timeoutMs: 60_000,
  });
  expect(init.exitCode).toBe(0);
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "test");
  await git(repo, "config", "commit.gpgsign", "false");
  await commit("a.txt", "one");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("spare claim", () => {
  test("a claim takes a ready spare: on the attempt branch, at main, locked", async () => {
    const spare = await createSpareIn(repo);
    expect(await listReadySpares(repo)).toEqual([spare]);

    const wt = wtFor("att-1");
    expect(await checkoutAttempt(repo, "att-1", wt)).toBe("spare");

    expect(existsSync(spare)).toBe(false);
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-1",
    );
    expect(await git(wt, "rev-parse", "HEAD")).toBe(
      await git(repo, "rev-parse", "main"),
    );
    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect(await lockOf(wt)).toBe("singularity agent worktree");
    expect(await listReadySpares(repo)).toEqual([]);
  });

  test("an unlocked (half-written) spare is skipped", async () => {
    const spare = await createSpareIn(repo);
    await git(repo, "worktree", "unlock", spare);
    expect(await listReadySpares(repo)).toEqual([]);

    const wt = wtFor("att-2");
    expect(await checkoutAttempt(repo, "att-2", wt)).toBe("fresh");
    expect(existsSync(spare)).toBe(true);
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-2",
    );
  });

  test("with no spare, the claim falls back to the cold add", async () => {
    const wt = wtFor("att-3");
    expect(await checkoutAttempt(repo, "att-3", wt)).toBe("fresh");
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-3",
    );
    expect(await lockOf(wt)).toBe("singularity agent worktree");
  });

  test("two concurrent claims of one spare: one wins, the other falls back", async () => {
    await createSpareIn(repo);
    const sources = await Promise.all([
      checkoutAttempt(repo, "att-4", wtFor("att-4")),
      checkoutAttempt(repo, "att-5", wtFor("att-5")),
    ]);
    expect([...sources].sort()).toEqual(["fresh", "spare"]);
    for (const id of ["att-4", "att-5"]) {
      expect(await git(wtFor(id), "symbolic-ref", "HEAD")).toBe(
        `refs/heads/claude-web/${id}`,
      );
      expect(await lockOf(wtFor(id))).toBe("singularity agent worktree");
    }
  });

  test("a spare made at an older main ends at the current main", async () => {
    await createSpareIn(repo);
    const head = await commit("b.txt", "two");

    const wt = wtFor("att-6");
    expect(await checkoutAttempt(repo, "att-6", wt)).toBe("spare");
    expect(await git(wt, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(wt, "b.txt"))).toBe(true);
    expect(await git(wt, "status", "--porcelain")).toBe("");
  });

  test("an existing attempt branch is checked out, not re-created", async () => {
    await createSpareIn(repo);
    await git(repo, "branch", "claude-web/att-7", "main");
    const branchHead = await git(repo, "rev-parse", "claude-web/att-7");
    await commit("c.txt", "three");

    const wt = wtFor("att-7");
    expect(await checkoutAttempt(repo, "att-7", wt)).toBe("spare");
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-7",
    );
    expect(await git(wt, "rev-parse", "HEAD")).toBe(branchHead);
  });
});

describe("crash convergence", () => {
  test("a spare moved into place but still detached is checked out again and locked", async () => {
    const spare = await createSpareIn(repo);
    const wt = wtFor("att-8");
    // The claim's first two steps, then a crash before the switch.
    await git(repo, "worktree", "unlock", spare);
    await git(repo, "worktree", "move", spare, wt);
    expect(await isUnfinishedSpareClaim(repo, wt)).toBe(true);

    expect(await convergeExistingCheckout(repo, "att-8", wt, noGate)).toEqual({
      source: "fresh",
    });
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-8",
    );
    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect(await lockOf(wt)).toBe("singularity agent worktree");
    expect(await isUnfinishedSpareClaim(repo, wt)).toBe(false);
  });

  test("a switch killed after writing an added file converges to a clean checkout", async () => {
    // The 2026-10-18 launch failure: a backend restart killed `git switch`
    // after it had written main's new files but before it moved HEAD or the
    // index, so every added file was left untracked and every later switch
    // refused with "untracked working tree file would be overwritten".
    const spare = await createSpareIn(repo);
    await commit("added.txt", "new on main");
    await commit("a.txt", "changed on main");
    const wt = wtFor("att-10");
    await git(repo, "worktree", "unlock", spare);
    await git(repo, "worktree", "move", spare, wt);
    // What the killed switch left: main's files written, HEAD still the spare's.
    writeFileSync(join(wt, "added.txt"), "new on main");
    writeFileSync(join(wt, "a.txt"), "changed on main");
    const plainSwitch = await spawnCaptured(
      [
        GIT,
        "-C",
        wt,
        "switch",
        "--discard-changes",
        "-c",
        "claude-web/att-10",
        "main",
      ],
      { timeoutMs: 60_000 },
    );
    expect(plainSwitch.exitCode).not.toBe(0);
    expect(plainSwitch.stderr).toContain("Untracked working tree file");
    expect(await isUnfinishedSpareClaim(repo, wt)).toBe(true);

    expect(
      (await convergeExistingCheckout(repo, "att-10", wt, noGate)).source,
    ).not.toBe("existing");
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-10",
    );
    expect(await git(wt, "rev-parse", "HEAD")).toBe(
      await git(repo, "rev-parse", "main"),
    );
    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect(await lockOf(wt)).toBe("singularity agent worktree");
  });

  test("a finished checkout is left in place and only re-locked", async () => {
    await createSpareIn(repo);
    const wt = wtFor("att-11");
    await checkoutAttempt(repo, "att-11", wt);
    writeFileSync(join(wt, "work.txt"), "the agent's work");
    await git(repo, "worktree", "unlock", wt);

    expect(await convergeExistingCheckout(repo, "att-11", wt, noGate)).toEqual({
      source: "existing",
    });
    expect(existsSync(join(wt, "work.txt"))).toBe(true);
    expect(await lockOf(wt)).toBe("singularity agent worktree");
  });

  test("a finished checkout on a detached HEAD (e.g. mid-rebase) is left alone", async () => {
    await createSpareIn(repo);
    const wt = wtFor("att-9");
    await checkoutAttempt(repo, "att-9", wt);
    await git(wt, "switch", "--detach", "HEAD");
    expect(await isUnfinishedSpareClaim(repo, wt)).toBe(false);
  });
});

describe("pruneSparesIn", () => {
  test("reclaims stale unlocked spares and over-age ready ones, keeps fresh ready ones", async () => {
    const ready = await createSpareIn(repo);
    const debris = await createSpareIn(repo);
    await git(repo, "worktree", "unlock", debris);

    const removed: string[] = [];
    const remove = async (p: string) => {
      removed.push(p);
    };
    // Just now: the unlocked one may still be mid-claim / mid-refill.
    expect(await pruneSparesIn(repo, Date.now(), remove)).toEqual([]);
    // 20 minutes on: the unlocked one is debris, the ready one is young.
    expect(await pruneSparesIn(repo, Date.now() + 20 * 60_000, remove)).toEqual(
      [debris],
    );
    // Two days on: the ready one is over-age too, and is unlocked to take it.
    removed.length = 0;
    const later = await pruneSparesIn(repo, Date.now() + 48 * 3600_000, remove);
    expect([...later].sort()).toEqual([ready, debris].sort());
    expect(await lockOf(ready)).toBeNull();
  });
});
