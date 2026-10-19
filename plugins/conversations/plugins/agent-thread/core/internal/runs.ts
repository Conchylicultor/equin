import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/** How many runs a host reads by default (the latest few is all a restore needs). */
export const THREAD_RUNS_DEFAULT_LIMIT = 20;

/**
 * The recent runs of the agents apps start: every conversation whose attempt
 * runs in a SCRATCH workspace (conversations/workspace), newest first, with
 * the scratch profile it was launched under. Read filtered by profile —
 * `useThreadRuns(profile)` — so a host restores its latest run after a reload
 * (Places reopening its progress pill) without remembering the id anywhere.
 *
 * A window over the `conversations` table with its attempt joined (served in
 * `../../server/internal/runs.ts`): `profile` is the attempt's
 * `workspace->>'profile'`, written once at insert, so a run's row moves only
 * with its conversation (a status flip, a retitle) — an attempt write reaches
 * no tuple unless it touches `workspace` or `task_id`.
 */
export const threadRuns = liveCollection("agent-thread.runs", {
  from: conversationsEntityRef,
  pick: ["status"],
  fields: {
    // Never NULL: the base `where` keeps only attempts whose spec names a
    // profile (a scratch one).
    profile: textField({ label: "Profile" }),
  },
  carry: {
    pick: ["id", "attemptId", "title", "createdAt", "endedAt"],
    fields: { taskId: textField() },
  },
  baseExposures: false,
  id: "id",
  sortable: ["createdAt"],
  default: {
    orderBy: [["createdAt", "desc"]],
    limit: THREAD_RUNS_DEFAULT_LIMIT,
  },
  maxLimit: 100,
});

/** One run as {@link threadRuns} delivers it; `id` is the conversation id. */
export type ThreadRun =
  typeof threadRuns extends LiveRowsCollection<infer R> ? R : never;
