import { rm } from "node:fs/promises";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { attemptEndings } from "@plugins/tasks/plugins/tasks-core/server";
import {
  announceWorkspacesReclaimed,
  WorkspaceReclaimed,
} from "@plugins/conversations/plugins/workspace/server";
import { scratchWorkspacesDir } from "../../data-dirs";
import { decideScratchReap } from "./reap-policy";

const reapLog = defineLogSink({
  id: "workspace-scratch-reap",
  description:
    "Scratch workspace reaper: every scratch directory removed, and why.",
});

/**
 * Deletes scratch workspaces whose task has been done or dropped for a week
 * (`reap-policy.ts`). Main only (the default for a schedule): main's database
 * holds the attempts the app launched, and one host-wide directory needs one
 * reaper. A workspace whose attempt lives in a worktree backend's database is
 * seen here without a row, and is kept until it has been untouched for the
 * same week.
 */
export const scratchReapJob = defineJob({
  name: "workspace.scratch-reap",
  description:
    "Deletes scratch agent workspaces a week after their task is done or dropped.",
  hold: "minutes",
  inProcess:
    "Each directory is decided and removed on its own; a run killed mid-way leaves the rest for the next one, and removing an already-removed directory is a no-op.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "20 5 * * *" },
  run: async () => {
    const root = await scratchWorkspacesDir.ensure();
    const entries = await readdir(root, { withFileTypes: true });
    const now = Date.now();
    const reclaimed: string[] = [];
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // Every workspace's attempt in one read: a directory per attempt ever
    // launched (~350), so two reads per directory was ~700 point reads,
    // each `tasks_v` one O(the dependency graph).
    const endings = await attemptEndings(dirs);
    try {
      for (const name of dirs) {
        const dir = scratchWorkspacesDir.file(name);
        const { mtimeMs } = await stat(dir);
        const decision = decideScratchReap(
          { attemptId: name, mtimeMs, attempt: endings.get(name) ?? null },
          now,
        );
        if (!decision.reap) continue;
        reapLog.publish(`removing ${dir}: ${decision.reason}`);
        await rm(dir, { recursive: true, force: true });
        reclaimed.push(name);
      }
    } finally {
      // Every directory removed so far, whatever stopped the loop: what other
      // plugins keep for these attempts is freed by them (the directory name
      // is the attempt id). The deletions are done either way, so a retry
      // would not announce them again — a handler that throws fails the run
      // loudly, and its leftovers are its own backstop's.
      await announceWorkspacesReclaimed(
        WorkspaceReclaimed.getContributions(),
        reclaimed,
      );
    }
  },
});
