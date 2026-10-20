import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { _tasksShortTitleExt } from "../../server/internal/tables";
import { enqueueShortTitles } from "./short-title-job";

// Only tasks with a conversation active this recently are backfilled, so the
// first boot does not spend a model call on every task ever filed. Older tasks
// keep showing their full title until they are renamed (or worked on again —
// `tasks.titleChanged` covers every new title from here on).
const RECENT_DAYS = 30;

// Seeds short titles for tasks that predate the `tasks.titleChanged`
// subscriber, and re-syncs any whose row went stale while no backend was
// running the subscriber. `dedup: "singleton"` collapses repeated enqueues.
// The scan itself only enqueues: the keyed, serial `task-title.short` job does
// the model calls, one at a time.
export const backfillShortTitlesJob = defineJob({
  name: "task-title.short-backfill",
  description:
    "Finds recently active tasks whose short title is missing or stale and queues them for regeneration.",
  // instant: one indexed read and N queue inserts — no model call here.
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    const recent = sql`now() - make_interval(days => ${RECENT_DAYS})`;
    const rows = await db
      .selectDistinct({ id: _tasks.id })
      .from(_tasks)
      .innerJoin(_attempts, eq(_attempts.taskId, _tasks.id))
      .innerJoin(
        _conversations,
        and(
          eq(_conversations.attemptId, _attempts.id),
          gt(_conversations.updatedAt, recent),
        ),
      )
      .leftJoin(_tasksShortTitleExt, eq(_tasksShortTitleExt.taskId, _tasks.id))
      .where(
        sql`${_tasksShortTitleExt.sourceTitle} IS DISTINCT FROM ${_tasks.title}`,
      );
    await enqueueShortTitles(rows.map((r) => r.id));
  },
});

// A declared warm-up rather than an `onReady` enqueue: deferred past
// serving-ready and throttled. `worktree` scope — tasks live in each
// backend's own DB; a fork inherits main's rows, so a worktree has nothing to
// seed unless it renamed tasks itself.
export const shortTitlesBackfillWarmup = defineWarmup({
  name: "task-title.short-backfill",
  description:
    "Queues short-title generation at startup for recently active tasks that lack a current short title.",
  scope: "worktree",
  run: async () => {
    await backfillShortTitlesJob.enqueue({});
  },
});
