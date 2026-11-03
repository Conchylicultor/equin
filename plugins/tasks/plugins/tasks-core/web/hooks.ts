import { useCallback } from "react";
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
 * "The attempts of a task" was filtered and sorted out of the global attempts
 * set in four places, and they did not agree on the direction. It reads
 * newest-first because that is what an attempt list is for: the attempt being
 * worked right now belongs at the top.
 *
 * The join runs as a `select`, so a surface re-renders when ITS OWN task's
 * attempts change rather than on every push to the global list.
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
  const select = useCallback(
    (attempts: readonly AttemptWithConversations[]) =>
      attempts
        .filter((attempt) => attempt.taskId === taskId)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [taskId],
  );
  return useLive(attemptRows, { select });
}

/**
 * Every run these tasks produced, oldest first.
 *
 * A task may be worked several times — `createConversation` with a `taskId` and
 * no `attemptId` mints a new attempt — so "the runs of a task" is its
 * conversations across every attempt. Oldest-first, the order they were
 * started: this is a timeline, not a list of current work, which is why it runs
 * the opposite way to {@link useTaskAttempts}. Two names and two stated orders,
 * rather than a coin flip at each call site.
 *
 * Takes a SET of tasks because a surface can have launched several — a prompt
 * block's chips are the runs of every task that block dispatched. A single-task
 * caller passes `[taskId]`.
 *
 * Same two properties as {@link useTaskAttempts}: it runs as a `select`, and it
 * hands back the resource state rather than collapsing "loading" into "none".
 */
export function useTaskConversations(
  taskIds: readonly string[],
): ResourceResult<readonly ConversationSummary[]> {
  // The id set travels as a string so the select's identity changes exactly
  // when the set does. A caller assembling `links.map(...)` inline hands over a
  // fresh array every render, and depending on that array would rebuild the
  // select — and re-run the join — each time.
  const key = [...taskIds].sort().join(" ");
  const select = useCallback(
    (attempts: readonly AttemptWithConversations[]) => {
      const ids = new Set(key.split(" ").filter(Boolean));
      return attempts
        .filter((attempt) => ids.has(attempt.taskId))
        .flatMap((attempt) => attempt.conversations)
        .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    },
    [key],
  );
  return useLive(attemptRows, { select });
}
