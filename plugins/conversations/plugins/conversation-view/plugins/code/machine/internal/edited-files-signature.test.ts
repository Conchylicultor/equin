import { mandatePolicy } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { db } from "@plugins/database/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  _tasks,
  createAttempt,
  createTask,
  insertConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  editedFilesSignature,
  readEditedFilesFacts,
} from "../../server/internal/edited-files-signature";
import { parsePorcelainZ } from "../../server/internal/edited-files-etag";
import { computeEditedFiles } from "../../server/internal/compute-edited-files";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { checkPagedSource } from "@plugins/network/plugins/live/server/testing";
import { resolved } from "@plugins/primitives/plugins/live-state/core";
import { editedFiles } from "../../core";
import type { EditedFile } from "../../core/protocol";
import { editedFilesMetaOf, loadEditedFilesFor } from "./edited-files-resource";

// Real throwaway git repos (no fixture helper exists for this shape — the nearest
// precedent is commit-list's run-git.test.ts, which also mkdtemps a repo under
// tmpdir). `editedFilesSignature` shells out to git and lstats real paths, so a
// fake would test nothing.

const repos: string[] = [];
const seededTasks: string[] = [];

/**
 * A repo with one commit on `main` containing `a.txt`, with a `feature` branch
 * checked out — the shape every conversation worktree has (HEAD ahead of, or
 * level with, main; `merge-base main HEAD` well-defined).
 */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "edited-files-sig-"));
  repos.push(dir);
  await runGit(["init", "-q"], dir);
  // Set the initial branch without relying on `git init -b` (newer git only).
  await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  await runGit(["config", "commit.gpgsign", "false"], dir);
  await writeFile(join(dir, "a.txt"), "one\n");
  await runGit(["add", "a.txt"], dir);
  await runGit(["commit", "-q", "-m", "initial"], dir);
  await runGit(["checkout", "-q", "-b", "feature"], dir);
  return dir;
}

/** The `${headSha}|${mergeBase}` prefix of the signature, before the dirty rows. */
function shaPart(signature: string): string {
  return signature.split("\0")[0]!;
}

afterAll(async () => {
  await Promise.all(repos.map((d) => rm(d, { recursive: true, force: true })));
  // Deleting the task cascades to its attempt + conversation (FK onDelete cascade).
  for (const id of seededTasks)
    await db.delete(_tasks).where(eq(_tasks.id, id));
});

describe("editedFilesSignature", () => {
  // THE property that lets the watcher generation counter die: an uncommitted save
  // moves no SHA, so a pure git-SHA signature would serve a stale value. The
  // per-dirty-file lstat (mtime+size) makes the content signature move anyway, so
  // `revalidate` and the loader's memo can share it as one authority.
  test("moves on an uncommitted edit with no SHA change", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    const before = await editedFilesSignature(repo);

    await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
    const after = await editedFilesSignature(repo);

    expect(after).not.toBe(before);
    // Neither HEAD nor the merge-base moved — only the working tree did.
    expect(shaPart(after)).toBe(shaPart(before));
  });

  test("moves when an untracked file appears", async () => {
    const repo = await makeRepo();
    const before = await editedFilesSignature(repo);

    await writeFile(join(repo, "new.txt"), "hello\n");
    const after = await editedFilesSignature(repo);

    expect(after).not.toBe(before);
    expect(shaPart(after)).toBe(shaPart(before));
  });

  test("moves when a dirty file is deleted", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    const dirty = await editedFilesSignature(repo);

    await unlink(join(repo, "a.txt"));
    const deleted = await editedFilesSignature(repo);

    expect(deleted).not.toBe(dirty);
    // The vanished path can't be lstat'd — it degrades to the -1 sentinels rather
    // than throwing, and the porcelain code flips to a delete.
    expect(deleted).toContain(":-1:-1:a.txt");
  });

  test("is stable across repeated probes with no change", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    await writeFile(join(repo, "untracked.txt"), "x\n");

    const first = await editedFilesSignature(repo);
    const second = await editedFilesSignature(repo);
    expect(second).toBe(first);
  });

  test("moves when main advances (merge-base changes)", async () => {
    const repo = await makeRepo();
    // Commit on feature; main still points at the initial commit.
    await writeFile(join(repo, "b.txt"), "b\n");
    await runGit(["add", "b.txt"], repo);
    await runGit(["commit", "-q", "-m", "feature work"], repo);
    const head = (await runGit(["rev-parse", "HEAD"], repo)).trim();

    const before = await editedFilesSignature(repo);

    // main advances onto HEAD (the branch landed) — merge-base moves, HEAD doesn't.
    await runGit(["update-ref", "refs/heads/main", head], repo);
    const after = await editedFilesSignature(repo);

    expect(after).not.toBe(before);
    // The merge-base half (after the `|`) is what moved; HEAD is unchanged.
    expect(before).not.toContain(`|${head}`);
    expect(after).toContain(`|${head}`);
  });
});

describe("compute and signature read one path set", () => {
  // Paths git C-quotes in non-`-z` output: a space, a quote, non-ASCII. The
  // compute once parsed quoted porcelain, so these never matched the diff's
  // paths and an untracked one counted 0 lines.
  const QUOTED = 'my "odd" é.txt';
  const TRACKED = "tracked café.txt";

  test("a C-quoted path is one entry in both, with its real line count", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, TRACKED), "a\n");
    await runGit(["add", TRACKED], repo);
    await runGit(["commit", "-q", "-m", "tracked"], repo);
    await writeFile(join(repo, TRACKED), "a\nb\nc\n"); // dirty, +2
    await writeFile(join(repo, QUOTED), "1\n2\n3\n"); // untracked, 3 lines

    const facts = await readEditedFilesFacts(repo);
    const files = await computeEditedFiles(repo, facts);
    const dirtyPaths = facts.dirty.map((e) => e.path).sort();
    expect(dirtyPaths).toEqual([QUOTED, TRACKED].sort());
    // Every dirty path the signature fingerprints is a file of the value, and
    // the value has no path the facts or the diff did not name.
    expect(files.map((f) => f.path).sort()).toEqual([QUOTED, TRACKED].sort());
    expect(files.find((f) => f.path === QUOTED)).toMatchObject({
      status: "untracked",
      additions: 3,
    });
    expect(files.find((f) => f.path === TRACKED)).toMatchObject({
      status: "added",
      additions: 3,
      deletions: 0,
    });
    // The signature names the raw path too.
    expect(await editedFilesSignature(repo)).toContain(`:${QUOTED}`);
  });
});

describe("the facts are `git status -uall`'s entries", () => {
  // The facts read `-unormal` and expand each untracked dir with `ls-files
  // --others` (the `-uall` walk is ~3× the paths); the two must agree entry
  // for entry, or the signature and the value would miss a file.
  test("untracked dirs expanded, embedded repos and ignored dirs as -uall has them", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, ".gitignore"), "ignored/\n");
    await runGit(["add", ".gitignore"], repo);
    await runGit(["commit", "-q", "-m", "ignore"], repo);
    await mkdir(join(repo, "new/deep"), { recursive: true });
    await writeFile(join(repo, "new/deep/f.txt"), "x\n");
    await writeFile(join(repo, "new/top é.txt"), "y\n");
    await mkdir(join(repo, "new/nested"));
    await runGit(["init", "-q"], join(repo, "new/nested"));
    await writeFile(join(repo, "new/nested/g.txt"), "z\n");
    await mkdir(join(repo, "ignored"));
    await writeFile(join(repo, "ignored/x.txt"), "q\n");
    await writeFile(join(repo, "loose.txt"), "w\n");
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");

    const uall = parsePorcelainZ(
      await runGit(
        [
          "status",
          "--porcelain",
          "--no-renames",
          "--untracked-files=all",
          "-z",
        ],
        repo,
      ),
    );
    const byPath = (a: { path: string }, b: { path: string }) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    const facts = await readEditedFilesFacts(repo);
    expect([...facts.dirty].sort(byPath)).toEqual([...uall].sort(byPath));
    expect(facts.dirty.map((e) => e.path)).toContain("new/nested/");
  });
});

describe("unresolvable worktree — one determinate unresolved state", () => {
  // An unresolvable worktree means the edited-file set is UNKNOWN, not empty. The
  // loader SAYS SO (`unresolved`, carried by the value's meta) instead of throwing
  // (the old wedge) or lying with `[]` — which would render a legitimate "no
  // changes" and arm the destructive Drop & Close.
  const NO_SUCH_CONVERSATION =
    "edited-files-signature-test-no-such-conversation";

  test("no worktree at all: unresolved, and so is the meta", async () => {
    const files = await loadEditedFilesFor(NO_SUCH_CONVERSATION);
    expect(files.resolved).toBe(false);
    expect(editedFilesMetaOf(files).resolved).toBe(false);
  });

  test("worktree reaped mid-compute: the same unresolved state", async () => {
    // A conversation whose worktreePath resolves in the DB but whose directory is
    // gone — the reap the `onWorktree` catch handles (git shelled in a vanished
    // cwd throws WorktreeGoneError), distinct from the never-had-a-worktree branch
    // above. It collapses to the SAME determinate non-value, not a transient throw.
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const goneWorktree = join(tmpdir(), `edited-files-reaped-${stamp}`); // never created
    const taskId = `edited-files-reaped-task-${stamp}`;
    const attemptId = `edited-files-reaped-attempt-${stamp}`;
    const convId = `edited-files-reaped-conv-${stamp}`;
    seededTasks.push(taskId);
    await createTask({
      id: taskId,
      title: "reaped-worktree fixture",
      mandate: mandatePolicy([]),
    });
    await createAttempt({
      id: attemptId,
      taskId,
      worktreePath: goneWorktree,
      workspace: { kind: "worktree" },
    });
    await insertConversation({
      id: convId,
      attemptId,
      runtime: "sdk",
      model: FALLBACK_MODEL,
      spawnedBy: "edited-files-signature-test",
    });

    const files = await loadEditedFilesFor(convId);
    expect(files.resolved).toBe(false);
  });
});

describe("edited-files pages and meta", () => {
  const file = (
    path: string,
    additions: number,
    deletions: number,
  ): EditedFile => ({
    path,
    status: "modified",
    additions,
    deletions,
  });
  const files = [
    file("src/b.ts", 3, 1),
    file("README.md", 1, 0),
    file("src/a.ts", 10, 4),
    file("research/plan.md", 2, 2),
  ];

  test("pages by path within the paged value's key contract", async () => {
    await checkPagedSource({
      value: editedFiles,
      query: { id: "conv" },
      loader: (_q, range) => sliceRange(editedFiles, files, range),
      items: files,
      limits: [1, 3],
    });
    expect(
      sliceRange(editedFiles, files, {
        after: null,
        until: null,
        limit: 10,
      }).map((f) => f.path),
    ).toEqual(["README.md", "research/plan.md", "src/a.ts", "src/b.ts"]);
  });

  test("the meta totals the whole set", () => {
    expect(editedFilesMetaOf(resolved(files))).toEqual(
      resolved({ count: 4, additions: 16, deletions: 7 }),
    );
    expect(editedFilesMetaOf(resolved([]))).toEqual(
      resolved({ count: 0, additions: 0, deletions: 0 }),
    );
  });
});
