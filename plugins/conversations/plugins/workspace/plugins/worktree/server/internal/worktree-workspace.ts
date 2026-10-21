import { existsSync } from "node:fs";
import { cp, stat } from "node:fs/promises";
import type { WorkspaceImpl } from "@plugins/conversations/plugins/workspace/server";
import { databaseForkJob } from "@plugins/database/plugins/fork/server";
import { getConfig } from "@plugins/config_v2/server";
import { configDir } from "@plugins/config_v2/data-dirs";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { attemptBranchName } from "@plugins/infra/plugins/worktree/core";
import {
  ensureMainWorktreeRoot,
  gitWorktreesDir,
  setupWorktree,
} from "@plugins/infra/plugins/worktree/server";
import { spareRefillJob } from "@plugins/infra/plugins/worktree/plugins/spare-pool/server";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";

// The agent's own git checkout of this repo, at `<repo>/.claude/worktrees/<id>`,
// with a forked DB and config dir of its own.
export const worktreeWorkspace: WorkspaceImpl<"worktree"> = {
  kind: "worktree",

  // A worktree is fully described by its kind.
  parseSpec(spec) {
    return spec;
  },

  async root() {
    return gitWorktreesDir(await ensureMainWorktreeRoot());
  },

  // The fork is a detached supervised job: it runs in its own process, so a
  // backend restart mid-fork does not interrupt it (the workflow re-attaches
  // to the running child). The enqueue is a row on the launch's transaction, so
  // it exists iff the attempt does. A failed fork retries, then dead-letters
  // (Debug → Queue) with a deduped fork-error notification; its output is on
  // the `database-fork` log channel (`logs/database-fork.jsonl`).
  //
  // It has no ordering dependency with `prepare`: the session only launches
  // the `claude` CLI, whose first worktree-DB op happens later at MCP/build
  // time, so the checkout and `pg_restore` run in parallel.
  async onCommit(tx, { attemptId }) {
    await databaseForkJob.enqueue(
      { source: "singularity", target: attemptId },
      { tx },
    );
  },

  async prepare({ attemptId, path }, signal) {
    // A checkout claims the namespace of its own name, so `setupWorktree`
    // refuses one a composition already holds. The manifest is read through
    // the config registry (the live view, so a Studio edit counts) here rather
    // than inside `infra/worktree`, which must stay importable from the CLI —
    // `config_v2/server` throws at module eval without a worktree identity.
    //
    // `signal` is the spawn dispatch's deadline. It reaches the host-wide
    // `worktree-mutate` gate and every git child underneath, so a checkout that
    // overruns stops holding one of the box's three worktree slots instead of
    // blocking checkouts on every other backend until the process restarts
    // (the 2026-08-17 shape).
    const { source } = await setupWorktree(
      attemptId,
      path,
      new Set(getConfig(compositionsConfig).manifests.map((m) => m.id)),
      signal,
    );
    // A checkout was made — from a spare (the pool is now one short) or cold
    // (the pool was empty) — so top the pool back up for the next launch. Off
    // the launch path: the refill is its own background job.
    if (source !== "existing") await spareRefillJob.enqueue({});
  },

  // Copy main's config dir for the new worktree — only after commit, so a
  // rolled-back launch leaves no config dir behind.
  async onFinish({ attemptId }) {
    await forkConfigDir(attemptId);
  },

  // The checkout carries the repo's own `.claude/settings.json` and
  // `.mcp.json`; the launch adds nothing.
  launch() {
    return { settings: {} };
  },

  // A conversation's checkout can be reclaimed underneath it while its branch
  // and transcript survive, and a process started with a missing cwd can
  // end up running somewhere else entirely, e.g. $HOME.
  // Unchecked, resuming such a conversation boots the agent in the user's home
  // directory with a transcript full of repo-relative paths, and the only
  // symptom is a trust prompt for `~`.
  checkResumable({ attemptId, path }) {
    if (existsSync(path)) return { kind: "ok" };
    const branch = attemptBranchName(attemptId);
    return {
      kind: "missing",
      message:
        `This conversation's worktree checkout is gone (${path}), so it cannot be resumed. ` +
        `Its branch ${branch} still exists — recreate the checkout with ` +
        `\`git worktree add ${path} ${branch}\` to bring the conversation back.`,
    };
  },
};

/**
 * Seed a new worktree's user config layer with main's: copy main's subtree of
 * the config dir (`config_v2/data-dirs`) to the worktree's. Main with no config
 * dir yet has nothing to copy.
 */
async function forkConfigDir(targetWorktree: string): Promise<void> {
  const sourceDir = configDir.file(MAIN_WORKTREE_NAME);
  const targetDir = configDir.file(targetWorktree);
  try {
    await stat(sourceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  await cp(sourceDir, targetDir, { recursive: true });
}
