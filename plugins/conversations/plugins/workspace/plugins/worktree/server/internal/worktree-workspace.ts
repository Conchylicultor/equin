import { existsSync } from "node:fs";
import { cp, stat } from "node:fs/promises";
import type { WorkspaceImpl } from "@plugins/conversations/plugins/workspace/server";
import { databaseForkJob } from "@plugins/database/plugins/fork/server";
import { configDir } from "@plugins/config_v2/data-dirs";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { attemptBranchName } from "@plugins/infra/plugins/worktree/core";
import { latestSupervisedRun } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import {
  adoptCompleteCheckout,
  checkoutState,
  ensureMainWorktreeRoot,
  gitWorktreesDir,
} from "@plugins/infra/plugins/worktree/server";
import { worktreePrepareJob } from "./prepare-job";
import { prepareWorktree } from "./prepare-wait";

// The agent's own git checkout of this repo, at `<repo>/.claude/worktrees/<id>`,
// with a forked DB and config dir of its own.
export const worktreeWorkspace: WorkspaceImpl<"worktree"> = {
  kind: "worktree",

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
      { source: MAIN_WORKTREE_NAME, target: attemptId },
      { tx },
    );
  },

  // The checkout is made by the supervised `worktree.prepare` child, which a
  // backend restart does not kill; this only requests it and waits, durably
  // (see `prepareWorktree`). A checkout that is already complete — a resume —
  // is adopted here in process, as fast as before.
  //
  // `signal` is the spawn dispatch's deadline. It reaches the in-process
  // adopt (the lock and the install's freshness check), so an overrun stops
  // instead of holding the spawn's slot.
  async prepare({ attemptId, path }, { signal, step, waitFor }) {
    const input = { attemptId, path };
    await prepareWorktree({ step, waitFor }, attemptId, {
      kindId: worktreePrepareJob.kind.id,
      checkoutState: async () =>
        checkoutState(await ensureMainWorktreeRoot(signal), path, signal),
      latestRun: () => latestSupervisedRun(worktreePrepareJob, input),
      request: async () => {
        await worktreePrepareJob.enqueue(input);
      },
      adopt: () => adoptCompleteCheckout(path, signal),
    });
  },

  // Copy main's config dir for the new worktree — only after commit, so a
  // rolled-back launch leaves no config dir behind.
  async onFinish({ attemptId }) {
    await forkConfigDir(attemptId);
  },

  // The checkout carries the repo's own `.claude/settings.json` and
  // `.mcp.json`. Its agent runs its OWN checkout's guards, so it can edit and
  // test them; the launch's policy hooks are byte-identical to the project's,
  // which Claude Code runs once.
  launch({ path }) {
    return { guardsRoot: path, settings: {} };
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
