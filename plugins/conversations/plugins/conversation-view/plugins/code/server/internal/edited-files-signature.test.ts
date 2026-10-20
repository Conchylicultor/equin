import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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
import { editedFilesSignature } from "./edited-files-signature";
import {
  editedFilesSignatureFor,
  loadEditedFilesFor,
} from "./edited-files-resource";

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

describe('unresolvable worktree — one consistent (unresolved, "no-worktree") pair', () => {
  // An unresolvable worktree means the edited-file set is UNKNOWN, not empty. The
  // loader now SAYS SO in the payload (`unresolved`) instead of throwing (the old
  // wedge) or lying with `[]`; the revalidate collapses onto the constant
  // `"no-worktree"` ETag. Both are produced from the SAME `onWorktree` branch, so
  // they are one consistent signature/value pair — never a fresh ETag over a stale
  // value. `[]` / `"none"` would render a legitimate "no changes" and arm the
  // destructive Drop & Close.
  const NO_SUCH_CONVERSATION =
    "edited-files-signature-test-no-such-conversation";

  test('no worktree at all: loader → unresolved, revalidate → "no-worktree"', async () => {
    const files = await loadEditedFilesFor(NO_SUCH_CONVERSATION);
    const signature = await editedFilesSignatureFor(NO_SUCH_CONVERSATION);
    expect(files.resolved).toBe(false);
    expect(signature).toBe("no-worktree");
  });

  test('worktree reaped mid-compute: same (unresolved, "no-worktree") pair', async () => {
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
    await createTask({ id: taskId, title: "reaped-worktree fixture" });
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
    const signature = await editedFilesSignatureFor(convId);
    expect(files.resolved).toBe(false);
    expect(signature).toBe("no-worktree");
  });
});
