import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { createSpareIn, pruneSparesIn } from "./spare";
import {
  ADD_IN_PROGRESS_LOCK,
  checkoutAttempt,
  checkoutState,
  convergeExistingCheckout,
  gitWorktreesDir,
  isUnfinishedCheckout,
  listReadySpares,
  listWorktreeEntries,
  lockWorktree,
  unlockWorktree,
} from "./worktree";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Every test runs against a throwaway repository — never the real checkout.
let base: AppPath;
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

async function commit(file: string, content: string): Promise<string> {
  writeFileSync(joinAppPath(repo, file), content);
  await git(repo, "add", file);
  await git(repo, "commit", "-q", "-m", `write ${file}`);
  return git(repo, "rev-parse", "HEAD");
}

const wtFor = (id: string) => join(gitWorktreesDir(repo), id);
const noGate = <T>(fn: () => Promise<T>) => fn();
const noInstall = async (): Promise<void> => {};

// What a concurrent `git worktree add` leaves for a moment: its admin entry
// with `commondir` created but not yet written.
function plantHalfWrittenAdd(id: string): void {
  const half = join(repo, ".git", "worktrees", id);
  mkdirSync(half);
  writeFileSync(join(half, "gitdir"), `${wtFor(id)}/.git\n`);
  writeFileSync(join(half, "HEAD"), `${"0".repeat(40)}\n`);
  writeFileSync(join(half, "commondir"), "");
}

// Runs `setupWorktree`'s cold path again after a crash, and checks it landed.
async function checkAttemptAgain(id: string, wt: string): Promise<string> {
  const source = await checkoutAttempt(repo, id, wt);
  expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
    `refs/heads/claude-web/${id}`,
  );
  expect(await git(wt, "status", "--porcelain")).toBe("");
  expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
  return source;
}

async function lockOf(path: string): Promise<string | null | undefined> {
  return (await listWorktreeEntries(repo)).find((e) => e.path === path)?.locked;
}

beforeEach(async () => {
  base = asAppPath(realpathSync(mkdtempSync(join(tmpdir(), "spare-test-"))));
  repo = joinAppPath(base, "repo");
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
    const spare = await createSpareIn(repo, noInstall);
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
    expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
    expect(await listReadySpares(repo)).toEqual([]);
  });

  test("a spare is installed before it is locked: ready means installed", async () => {
    const seen: { path: string; lock: string | null | undefined }[] = [];
    const spare = await createSpareIn(repo, async (path) => {
      seen.push({ path, lock: await lockOf(path) });
    });
    expect(seen).toEqual([{ path: spare, lock: null }]);
    expect(await listReadySpares(repo)).toEqual([spare]);
  });

  test("a spare whose install fails throws and is never ready", async () => {
    let path = "";
    expect(
      createSpareIn(repo, async (p) => {
        path = p;
        throw new Error("bun install exited 1");
      }),
    ).rejects.toMatchObject({ message: "bun install exited 1" });
    expect(existsSync(path)).toBe(true);
    expect(await lockOf(path)).toBeNull();
    expect(await listReadySpares(repo)).toEqual([]);
  });

  test("an unlocked (half-written) spare is skipped", async () => {
    const spare = await createSpareIn(repo, noInstall);
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
    expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
  });

  test("two concurrent claims of one spare: one wins, the other falls back", async () => {
    await createSpareIn(repo, noInstall);
    const sources = await Promise.all([
      checkoutAttempt(repo, "att-4", wtFor("att-4")),
      checkoutAttempt(repo, "att-5", wtFor("att-5")),
    ]);
    expect([...sources].sort()).toEqual(["fresh", "spare"]);
    for (const id of ["att-4", "att-5"]) {
      expect(await git(wtFor(id), "symbolic-ref", "HEAD")).toBe(
        `refs/heads/claude-web/${id}`,
      );
      expect(await lockOf(wtFor(id))).toBe(LEGACY_IDS.worktreeLockReason);
    }
  });

  test("lock and unlock hold while another worktree's add is half-written", async () => {
    // What a concurrent `git worktree add` leaves for a moment: its admin
    // entry with `commondir` created but not yet written. `git worktree lock`
    // dies on it ("failed to read …/commondir") — 2026-11-02: a claim's
    // checkout was left unlocked while another add ran beside it.
    const spare = await createSpareIn(repo, noInstall);
    plantHalfWrittenAdd("att-half");
    const raced = await spawnCaptured(
      [GIT, "-C", repo, "worktree", "lock", spare, "--reason", "x"],
      { timeoutMs: 60_000 },
    );
    expect(raced.stderr).toContain("commondir");

    expect(await unlockWorktree(repo, spare)).toBe("unlocked");
    expect(await unlockWorktree(repo, spare)).toBe("not-locked");
    expect(await lockWorktree(repo, spare, "mine")).toBe("locked");
    expect(await lockWorktree(repo, spare, "other")).toBe("already-locked");
    expect(await lockWorktree(repo, wtFor("att-none"), "x")).toBe(
      "unregistered",
    );
    expect(await lockOf(spare)).toBe("mine");
  });

  test("the list readers hold while another worktree's add is half-written", async () => {
    // `git worktree list` dies on the same state as `lock` — and with it every
    // reader of the list: a claim's spare lookup, the crash check, the prune,
    // a removal's registration check.
    const spare = await createSpareIn(repo, noInstall);
    plantHalfWrittenAdd("att-half");
    const raced = await spawnCaptured(
      [GIT, "-C", repo, "worktree", "list", "--porcelain"],
      { timeoutMs: 60_000 },
    );
    expect(raced.stderr).toContain("commondir");

    expect((await listWorktreeEntries(repo)).map((e) => e.path)).toEqual([
      repo,
      wtFor("att-half"),
      spare,
    ]);
    expect(await listReadySpares(repo)).toEqual([spare]);
    expect(await isUnfinishedCheckout(repo, spare)).toBe(false);
    expect(await checkoutState(repo, spare)).toBe("complete");
    const noRemove = async (path: string): Promise<void> => {
      throw new Error(`removed ${path}`);
    };
    expect(await pruneSparesIn(repo, Date.now(), noRemove)).toEqual([]);
  });

  test("claims and cold adds hold while another worktree's add is half-written", async () => {
    // `git worktree add` / `move` / `switch <branch>` enumerate every worktree
    // and die on the same state as `list` — a claim's move and the cold add
    // fell over beside a concurrent refill (task-1793664733-b6mwon).
    const spare = await createSpareIn(repo, noInstall);
    plantHalfWrittenAdd("att-half");
    for (const argv of [
      ["worktree", "add", "--detach", wtFor("att-raw"), "main"],
      ["worktree", "move", spare, wtFor("att-raw")],
    ]) {
      const raced = await spawnCaptured([GIT, "-C", repo, ...argv], {
        timeoutMs: 60_000,
      });
      expect(raced.stderr).toContain("commondir");
    }

    // A claim (the switch creates the branch) …
    const claimed = wtFor("att-claim");
    expect(await checkoutAttempt(repo, "att-claim", claimed)).toBe("spare");
    // … a claim onto a branch that already exists …
    await git(repo, "branch", "claude-web/att-old", "main");
    await createSpareIn(repo, noInstall);
    const reclaimed = wtFor("att-old");
    expect(await checkoutAttempt(repo, "att-old", reclaimed)).toBe("spare");
    // … a cold add of a new branch, and one of an existing branch.
    const fresh = wtFor("att-fresh");
    expect(await checkoutAttempt(repo, "att-fresh", fresh)).toBe("fresh");
    await git(repo, "branch", "claude-web/att-kept", "main");
    const kept = wtFor("att-kept");
    expect(await checkoutAttempt(repo, "att-kept", kept)).toBe("fresh");

    for (const [id, wt] of [
      ["att-claim", claimed],
      ["att-old", reclaimed],
      ["att-fresh", fresh],
      ["att-kept", kept],
    ] as const) {
      expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
        `refs/heads/claude-web/${id}`,
      );
      expect(await git(wt, "status", "--porcelain")).toBe("");
      expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
    }
    // git itself reads every entry written here, once the planted one is gone.
    rmSync(join(repo, ".git", "worktrees", "att-half"), { recursive: true });
    const listed = await git(repo, "worktree", "list", "--porcelain");
    for (const wt of [claimed, reclaimed, fresh, kept]) {
      expect(listed).toContain(`worktree ${wt}\n`);
    }
    expect(listed).not.toContain(spare);
  });

  test("a new checkout is registered as git would: same files, same admin entry", async () => {
    const wt = wtFor("att-shape");
    expect(await checkoutAttempt(repo, "att-shape", wt)).toBe("fresh");
    const admin = await git(wt, "rev-parse", "--absolute-git-dir");
    expect(admin).toBe(join(repo, ".git", "worktrees", "att-shape"));
    expect(
      await git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    ).toBe(join(repo, ".git"));
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(
      await git(repo, "reflog", "-1", "--format=%gs", "claude-web/att-shape"),
    ).toBe("branch: Created from main");
    // git can take it apart again.
    await git(repo, "worktree", "unlock", wt);
    await git(repo, "worktree", "remove", wt);
    expect(existsSync(admin)).toBe(false);
  });

  test("a claim refuses a branch already checked out elsewhere, as git would", async () => {
    await git(repo, "branch", "claude-web/att-dup", "main");
    await git(
      repo,
      "worktree",
      "add",
      "-q",
      wtFor("elsewhere"),
      "claude-web/att-dup",
    );
    await createSpareIn(repo, noInstall);
    expect(
      await checkoutAttempt(repo, "att-dup", wtFor("att-dup")).then(
        () => "ok",
        (err: Error) => err.message,
      ),
    ).toContain("already checked out at");
  });

  test("an add killed before its dir was made is discarded by the next add", async () => {
    // The entry is published (locked "initializing") before the dir exists.
    const wt = wtFor("att-early");
    expect(await checkoutAttempt(repo, "att-early", wt)).toBe("fresh");
    await git(repo, "worktree", "unlock", wt);
    writeFileSync(
      join(repo, ".git", "worktrees", "att-early", "locked"),
      `${ADD_IN_PROGRESS_LOCK}\n`,
    );
    rmSync(wt, { recursive: true });
    expect(await checkAttemptAgain("att-early", wt)).toBe("fresh");
  });

  test("a claim cut off between its gitdir rewrite and its move converges", async () => {
    // The claim unlocks the spare, rewrites its entry's gitdir to the
    // attempt's path, then moves the dir: a crash between leaves an unlocked
    // entry naming an absent path, and the spare dir stranded, unregistered.
    const spare = await createSpareIn(repo, noInstall);
    const wt = wtFor("att-cut");
    const admin = join(repo, ".git", "worktrees", basename(spare));
    rmSync(join(admin, "locked"));
    writeFileSync(join(admin, "gitdir"), `${join(wt, ".git")}\n`);

    expect(await checkAttemptAgain("att-cut", wt)).toBe("fresh");
    // The stranded spare is debris the prune reclaims.
    const removed: string[] = [];
    await pruneSparesIn(repo, Date.now() + 20 * 60_000, async (p) => {
      removed.push(p);
    });
    expect(removed).toEqual([spare]);
  });

  test("the listing reads what `git worktree list` reports", async () => {
    const spare = await createSpareIn(repo, noInstall);
    const branch = wtFor("att-branch");
    await git(repo, "worktree", "add", "-q", "-b", "b1", branch);
    await git(repo, "worktree", "lock", branch);
    const gone = wtFor("att-gone");
    await git(repo, "worktree", "add", "-q", "--detach", gone);
    rmSync(gone, { recursive: true });

    const porcelain = await git(repo, "worktree", "list", "--porcelain");
    const fromGit = porcelain.split("\n\n").map((block) => {
      const lines = block.split("\n");
      const field = (k: string) =>
        lines.find((l) => l === k || l.startsWith(`${k} `));
      const locked = field("locked");
      return {
        path: field("worktree")!.slice("worktree ".length),
        head: lines.includes("detached")
          ? field("HEAD")!.slice("HEAD ".length)
          : field("branch")!.slice("branch ".length),
        locked:
          locked === undefined ? null : locked.slice("locked".length).trim(),
        prunable: field("prunable") !== undefined,
      };
    });
    const ours = (await listWorktreeEntries(repo)).map((e) => ({
      path: e.path,
      head: e.head?.kind === "branch" ? e.head.ref : e.head?.commit,
      locked: e.locked,
      prunable: e.prunable,
    }));
    expect(ours).toEqual(fromGit);
    expect(ours.map((e) => e.path)).toEqual([repo, branch, gone, spare]);
    expect(ours[1]!.locked).toBe("");
  });

  test("a spare made at an older main ends at the current main", async () => {
    await createSpareIn(repo, noInstall);
    const head = await commit("b.txt", "two");

    const wt = wtFor("att-6");
    expect(await checkoutAttempt(repo, "att-6", wt)).toBe("spare");
    expect(await git(wt, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(wt, "b.txt"))).toBe(true);
    expect(await git(wt, "status", "--porcelain")).toBe("");
  });

  test("an existing attempt branch is checked out, not re-created", async () => {
    await createSpareIn(repo, noInstall);
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
    const spare = await createSpareIn(repo, noInstall);
    const wt = wtFor("att-8");
    // The claim's first two steps, then a crash before the switch.
    await git(repo, "worktree", "unlock", spare);
    await git(repo, "worktree", "move", spare, wt);
    expect(await isUnfinishedCheckout(repo, wt)).toBe(true);

    expect(await convergeExistingCheckout(repo, "att-8", wt, noGate)).toEqual({
      source: "fresh",
    });
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-8",
    );
    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
    expect(await isUnfinishedCheckout(repo, wt)).toBe(false);
  });

  test("a switch killed after writing an added file converges to a clean checkout", async () => {
    // The 2026-10-18 launch failure: a backend restart killed `git switch`
    // after it had written main's new files but before it moved HEAD or the
    // index, so every added file was left untracked and every later switch
    // refused with "untracked working tree file would be overwritten".
    const spare = await createSpareIn(repo, noInstall);
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
    expect(await isUnfinishedCheckout(repo, wt)).toBe(true);

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
    expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
  });

  test("an add killed mid-checkout (git's own lock still on) is checked out again and locked", async () => {
    // The 2026-10-28 launch failure: main's auto-restart killed the cold
    // `git worktree add` half-way, leaving the attempt's dir with most files
    // (the CLI among them) unwritten and git's "initializing" lock in place.
    // Every retry adopted it as finished and failed running `<wt>/equin install`.
    const wt = wtFor("att-12");
    await git(
      repo,
      "worktree",
      "add",
      "--no-checkout",
      "-b",
      "claude-web/att-12",
      wt,
      "main",
    );
    const admin = await git(wt, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(admin, "locked"), ADD_IN_PROGRESS_LOCK);
    expect(existsSync(join(wt, "a.txt"))).toBe(false);
    expect(await isUnfinishedCheckout(repo, wt)).toBe(true);

    expect(
      (await convergeExistingCheckout(repo, "att-12", wt, noGate)).source,
    ).not.toBe("existing");
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-12",
    );
    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
    expect(await isUnfinishedCheckout(repo, wt)).toBe(false);
  });

  test("a finished checkout is left in place and only re-locked", async () => {
    await createSpareIn(repo, noInstall);
    const wt = wtFor("att-11");
    await checkoutAttempt(repo, "att-11", wt);
    writeFileSync(join(wt, "work.txt"), "the agent's work");
    await git(repo, "worktree", "unlock", wt);

    expect(await convergeExistingCheckout(repo, "att-11", wt, noGate)).toEqual({
      source: "existing",
    });
    expect(existsSync(join(wt, "work.txt"))).toBe(true);
    expect(await lockOf(wt)).toBe(LEGACY_IDS.worktreeLockReason);
  });

  test("a finished checkout on a detached HEAD (e.g. mid-rebase) is left alone", async () => {
    await createSpareIn(repo, noInstall);
    const wt = wtFor("att-9");
    await checkoutAttempt(repo, "att-9", wt);
    await git(wt, "switch", "--detach", "HEAD");
    expect(await isUnfinishedCheckout(repo, wt)).toBe(false);
  });
});

describe("checkoutState", () => {
  test("absent, unfinished (a killed add or claim), complete — and it never discards", async () => {
    const wt = wtFor("att-20");
    expect(await checkoutState(repo, wt)).toBe("absent");

    // A cold add killed mid-checkout: git's own lock still on.
    await git(
      repo,
      "worktree",
      "add",
      "--no-checkout",
      "-b",
      "claude-web/att-20",
      wt,
      "main",
    );
    const admin = await git(wt, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(admin, "locked"), ADD_IN_PROGRESS_LOCK);
    expect(await checkoutState(repo, wt)).toBe("unfinished");
    // Read-only: the cut-off add is still there, lock and all.
    expect(existsSync(wt)).toBe(true);
    expect(await lockOf(wt)).toBe(ADD_IN_PROGRESS_LOCK);

    // A spare moved into place whose switch never ran.
    const spare = await createSpareIn(repo, noInstall);
    const claimed = wtFor("att-21");
    await git(repo, "worktree", "unlock", spare);
    await git(repo, "worktree", "move", spare, claimed);
    expect(await checkoutState(repo, claimed)).toBe("unfinished");

    const done = wtFor("att-22");
    await checkoutAttempt(repo, "att-22", done);
    expect(await checkoutState(repo, done)).toBe("complete");
  });
});

describe("pruneSparesIn", () => {
  test("reclaims stale unlocked spares and over-age ready ones, keeps fresh ready ones", async () => {
    const ready = await createSpareIn(repo, noInstall);
    const debris = await createSpareIn(repo, noInstall);
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

  test("reclaims a stale spare whose add was killed (git's own lock still on)", async () => {
    const killed = await createSpareIn(repo, noInstall);
    await git(repo, "worktree", "unlock", killed);
    await git(
      repo,
      "worktree",
      "lock",
      killed,
      "--reason",
      ADD_IN_PROGRESS_LOCK,
    );
    const remove = async (): Promise<void> => {};
    // Just now: the add may still be running.
    expect(await pruneSparesIn(repo, Date.now(), remove)).toEqual([]);
    expect(await pruneSparesIn(repo, Date.now() + 20 * 60_000, remove)).toEqual(
      [killed],
    );
  });
});
