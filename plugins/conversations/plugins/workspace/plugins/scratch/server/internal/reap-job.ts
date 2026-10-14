import { readdir, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { getAttempt, getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { scratchWorkspacesDir } from "../../data-dirs";
import { decideScratchReap, type ScratchDirFacts } from "./reap-policy";

const reapLog = defineLogSink({
  id: "workspace-scratch-reap",
  description:
    "Scratch workspace reaper: every scratch directory removed, and why.",
  consumer: {
    kind: "internal",
    note: "Scratch-workspace reaper prose (conversations/workspace/scratch, daily job): one line per agent scratch dir deleted and why (task dropped/finished > 7 days, or orphaned). Housekeeping record; a failed reap throws in the job, which the jobs plugin surfaces.",
  },
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
    const root = scratchWorkspacesDir.ensure();
    const entries = await readdir(root, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = scratchWorkspacesDir.file(entry.name);
      const decision = decideScratchReap(await factsOf(entry.name, dir), now);
      if (!decision.reap) continue;
      reapLog.publish(`removing ${dir}: ${decision.reason}`);
      await rm(dir, { recursive: true, force: true });
    }
  },
});

async function factsOf(
  attemptId: string,
  dir: string,
): Promise<ScratchDirFacts> {
  const { mtimeMs } = await stat(dir);
  const attempt = await getAttempt(attemptId);
  if (!attempt) return { attemptId, mtimeMs, attempt: null };
  const task = await getTask(attempt.taskId);
  return {
    attemptId,
    mtimeMs,
    attempt: {
      retained: attempt.retained,
      finishedAt: attempt.finishedAt,
      taskDroppedAt: task?.droppedAt ?? null,
    },
  };
}
