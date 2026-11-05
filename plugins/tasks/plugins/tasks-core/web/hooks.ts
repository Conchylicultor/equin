import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  attemptRows,
  type AttemptWithConversations,
  type ConversationSummary,
} from "@plugins/tasks/plugins/tasks-core/core";

/**
 * This task's attempts, newest first.
 *
 * A read of the task's own scope of `attemptRows` (`{ where: { taskId } }`), so
 * it loads only this task's attempts and re-renders only when they change. It
 * reads newest-first because that is what an attempt list is for: the attempt
 * being worked right now belongs at the top.
 *
 * It hands back the resource STATE, not a list: "still loading" and "this task
 * has never been attempted" are different answers, and a hook that returned an
 * empty array for both would hand every caller the second one during the load
 * window. Each caller narrows it and renders the two its own way — a spinner
 * suits a detail section, nothing at all suits a chip row.
 */
export function useTaskAttempts(
  taskId: string,
): ResourceResult<readonly AttemptWithConversations[]> {
  return useLive(attemptRows, { where: { taskId }, select: newestFirst });
}

const newestFirst = (attempts: readonly AttemptWithConversations[]) =>
  attempts.toSorted((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

/**
 * Every run this task produced, oldest first.
 *
 * A task may be worked several times — `createConversation` with a `taskId` and
 * no `attemptId` mints a new attempt — so "the runs of a task" is its
 * conversations across every attempt. Oldest-first, the order they were
 * started: this is a timeline, not a list of current work, which is why it runs
 * the opposite way to {@link useTaskAttempts}. Two names and two stated orders,
 * rather than a coin flip at each call site.
 *
 * One task: a surface showing the runs of several (a prompt block's chips)
 * renders one strip per task, each its own scoped read.
 *
 * Same two properties as {@link useTaskAttempts}: it reads the task's own
 * scope, and it hands back the resource state rather than collapsing
 * "loading" into "none".
 */
export function useTaskConversations(
  taskId: string,
): ResourceResult<readonly ConversationSummary[]> {
  return useLive(attemptRows, { where: { taskId }, select: runsOldestFirst });
}

const runsOldestFirst = (attempts: readonly AttemptWithConversations[]) =>
  attempts
    .flatMap((attempt) => attempt.conversations)
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
