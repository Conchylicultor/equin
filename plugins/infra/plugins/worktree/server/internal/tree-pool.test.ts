import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  emptyTreePool,
  harvestTree,
  takeTree,
  trashedIndexPath,
  treePoolDir,
} from "./tree-pool";
import { addCheckout, gitWorktreesDir } from "./worktree";

// Every test runs against a throwaway repository — never the real checkout.
let base: AppPath;
let repo: AppPath;
const DAY = 24 * 60 * 60_000;
// Harvests a minute ago: `addCheckout` takes a tree by the real clock.
const T = Date.now() - 60_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnCaptured([GIT, "-C", cwd, ...args], {
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function commit(files: Record<string, string | null>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await git(repo, "rm", "-q", file);
    else {
      writeFileSync(joinAppPath(repo, file), content);
      await git(repo, "add", file);
    }
  }
  await git(repo, "commit", "-q", "-m", "change");
}

const wtFor = (id: string) => join(gitWorktreesDir(repo), id);
const poolNames = () =>
  existsSync(treePoolDir(repo)) ? readdirSync(treePoolDir(repo)).sort() : [];

/**
 * What `removeWorktree` does to a checkout, without its host-wide gate: the
 * dir renamed into the trash, its index kept beside it, the registration
 * pruned. Returns the trash entry.
 */
async function removeLikeTheReaper(id: string, now: number): Promise<string> {
  const wt = wtFor(id);
  const admin = join(repo, ".git", "worktrees", id);
  const trash = join(repo, ".claude", "worktree-trash", `${now}-${id}`);
  mkdirSync(join(trash, ".."), { recursive: true });
  renameSync(wt, trash);
  renameSync(join(admin, "index"), trashedIndexPath(trash));
  await git(repo, "worktree", "prune");
  return trash;
}

beforeEach(async () => {
  base = asAppPath(realpathSync(mkdtempSync(join(tmpdir(), "tree-pool-"))));
  repo = joinAppPath(base, "repo");
  const init = await spawnCaptured([GIT, "init", "-q", "-b", "main", repo], {
    timeoutMs: 60_000,
  });
  expect(init.exitCode).toBe(0);
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "test");
  await git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  await commit({
    ".gitignore": "node_modules/\ndist/\n",
    "kept.txt": "same",
    "changed.txt": "old",
    "dropped.txt": "gone soon",
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("a removed checkout's tree goes to the next checkout", () => {
  test("only the files that differ are written, and the result is the target exactly", async () => {
    const old = wtFor("att-old");
    await addCheckout(
      "att-old",
      repo,
      old,
      { kind: "detached", rev: "main" },
      {
        recycle: false,
      },
    );
    // What its agent left: an edit, an untracked file, ignored output, the
    // `node_modules` links a store's harvest leaves.
    writeFileSync(join(old, "kept.txt"), "edited by the agent");
    writeFileSync(join(old, "notes.md"), "untracked");
    mkdirSync(join(old, "dist"));
    writeFileSync(join(old, "dist", "out.js"), "built");
    mkdirSync(join(old, "node_modules", "left-pad"), { recursive: true });
    await git(old, "checkout", "--", "kept.txt"); // back to clean, rewritten
    const keptInode = statSync(join(old, "kept.txt")).ino;

    const trash = await removeLikeTheReaper("att-old", T);
    expect(await harvestTree(repo, trash, T)).toEqual({
      kind: "harvested",
      entry: `${T}-att-old`,
    });
    expect(existsSync(trash)).toBe(false);
    expect(existsSync(trashedIndexPath(trash))).toBe(false);

    await commit({
      "changed.txt": "new",
      "dropped.txt": null,
      "added.txt": "+",
    });
    const wt = wtFor("att-new");
    const start = await addCheckout(
      "att-new",
      repo,
      wt,
      { kind: "new-branch", branch: "claude-web/att-new", from: "main" },
      { recycle: true },
    );
    expect(start).toMatchObject({ kind: "recycled", entry: `${T}-att-old` });
    expect(await git(wt, "status", "--porcelain", "--ignored")).toBe("");
    expect(await git(wt, "symbolic-ref", "HEAD")).toBe(
      "refs/heads/claude-web/att-new",
    );
    expect(readFileSync(join(wt, "changed.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(wt, "added.txt"), "utf8")).toBe("+");
    expect(existsSync(join(wt, "dropped.txt"))).toBe(false);
    expect(existsSync(join(wt, "notes.md"))).toBe(false);
    expect(existsSync(join(wt, "dist"))).toBe(false);
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    // Not rewritten: the same file, trusted through the carried index.
    expect(statSync(join(wt, "kept.txt")).ino).toBe(keptInode);
    expect(poolNames()).toEqual([]);
  });

  test("with no tree waiting, every file is written", async () => {
    const wt = wtFor("att-1");
    expect(
      await addCheckout(
        "att-1",
        repo,
        wt,
        { kind: "detached", rev: "main" },
        {
          recycle: true,
        },
      ),
    ).toEqual({ kind: "empty" });
    expect(await git(wt, "status", "--porcelain")).toBe("");
  });

  test("a tree that cannot be brought to the target is discarded and the checkout written from empty", async () => {
    await addCheckout(
      "att-old",
      repo,
      wtFor("att-old"),
      {
        kind: "detached",
        rev: "main",
      },
      { recycle: false },
    );
    const trash = await removeLikeTheReaper("att-old", T);
    writeFileSync(trashedIndexPath(trash), "not an index");
    expect((await harvestTree(repo, trash, T)).kind).toBe("harvested");

    const wt = wtFor("att-new");
    const start = await addCheckout(
      "att-new",
      repo,
      wt,
      { kind: "detached", rev: "main" },
      { recycle: true },
    );
    expect(start.kind).toBe("empty");
    expect(start.kind === "empty" && start.recycleFailed).toContain("index");
    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect(poolNames()).toEqual([]);
  });

  test("an index git would not compare with its files is not trusted", async () => {
    const old = wtFor("att-old");
    await addCheckout(
      "att-old",
      repo,
      old,
      { kind: "detached", rev: "main" },
      {
        recycle: false,
      },
    );
    await git(old, "update-index", "--skip-worktree", "kept.txt");
    rmSync(join(old, "kept.txt"));
    await harvestTree(repo, await removeLikeTheReaper("att-old", T), T);

    const wt = wtFor("att-new");
    const start = await addCheckout(
      "att-new",
      repo,
      wt,
      { kind: "detached", rev: "main" },
      { recycle: true },
    );
    expect(start.kind === "empty" && start.recycleFailed).toContain(
      "skip-worktree",
    );
    expect(readFileSync(join(wt, "kept.txt"), "utf8")).toBe("same");
    expect(poolNames()).toEqual([]);
  });

  test("a checkout with no index is not kept", async () => {
    await addCheckout(
      "att-old",
      repo,
      wtFor("att-old"),
      {
        kind: "detached",
        rev: "main",
      },
      { recycle: false },
    );
    const trash = await removeLikeTheReaper("att-old", T);
    rmSync(trashedIndexPath(trash));
    expect(await harvestTree(repo, trash, T)).toEqual({
      kind: "skipped",
      why: "no git index",
    });
    expect(existsSync(trash)).toBe(true);
    expect(poolNames()).toEqual([]);
  });

  test("a tree past its age bound is deleted, never taken", async () => {
    await addCheckout(
      "att-old",
      repo,
      wtFor("att-old"),
      {
        kind: "detached",
        rev: "main",
      },
      { recycle: false },
    );
    const trash = await removeLikeTheReaper("att-old", T);
    await harvestTree(repo, trash, T);
    expect(await takeTree(repo, T + 4 * DAY)).toBeNull();
    expect(await emptyTreePool(repo, T + 4 * DAY)).toBe(1);
    expect(poolNames()).toEqual([]);
  });

  test("two takers of one tree: one gets it", async () => {
    await addCheckout(
      "att-old",
      repo,
      wtFor("att-old"),
      {
        kind: "detached",
        rev: "main",
      },
      { recycle: false },
    );
    await harvestTree(repo, await removeLikeTheReaper("att-old", T), T);
    const [a, b] = await Promise.all([takeTree(repo, T), takeTree(repo, T)]);
    expect([a, b].filter((t) => t !== null)).toHaveLength(1);
  });
});
