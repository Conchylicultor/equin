/**
 * Who owns a task — the ONE rule behind what an agent may manage
 * (`edit_task` / `drop_task`) and whose leftovers block its exit
 * (`open-sidequests-gate.ts`). First match wins:
 *
 * 1. **A claim** (`TaskOwnerClaim`, orchestration/mandate): a workflow that
 *    gives tasks an owner the tree does not show — a supervisor role owns its
 *    backlog and its session trees.
 * 2. **A supervisor**: the task sits below the root of a tree whose mandate is
 *    a kind of `supervisor` — whatever its workers file is the supervisor's.
 * 3. **Its filer**: an agent filed it — owned by the TASK whose conversation
 *    filed it, so a resumed or relaunched conversation keeps its filings.
 * 4. **A person** (or the system): nobody an agent can act as.
 *
 * A task's owner only ever narrows what an agent may do: no agent manages a
 * task another party owns.
 */

import { db } from "@plugins/database/server";
import {
  getConversation,
  getTask,
  nearestMandate,
} from "@plugins/tasks/plugins/tasks-core/server";
import { taskAuthorOf } from "@plugins/tasks/plugins/tasks-core/core";
import { claimedOwnerOf } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { mandateIsKindOf } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/server";
import { supervisorMandate } from "@plugins/tasks/plugins/mandate-presets/core";

export type TaskOwnership =
  | {
      kind: "claimed";
      label: string;
      owns: (conversationId: string) => Promise<boolean>;
    }
  | { kind: "supervisor"; rootTaskId: string }
  | { kind: "filer"; taskId: string }
  | { kind: "person"; label: "a person" | "the system" };

/** Whether `taskId` sits in a supervisor's tree, its root included: the
 * tasks its agent files land in that tree (or a role's backlog), so they are
 * never its own as their filer. */
export async function inSupervisorTree(taskId: string): Promise<boolean> {
  const nearest = await nearestMandate(taskId, db);
  return (
    nearest.kind === "found" &&
    mandateIsKindOf(nearest.mandateId, supervisorMandate)
  );
}

/** `taskId`'s owner, or `null` for an id no task has. */
export async function taskOwnership(
  taskId: string,
): Promise<TaskOwnership | null> {
  const task = await getTask(taskId);
  if (task === null) return null;
  const claimed = await claimedOwnerOf(taskId);
  if (claimed !== null) return { kind: "claimed", ...claimed };
  const nearest = await nearestMandate(taskId, db);
  if (
    nearest.kind === "found" &&
    nearest.rootTaskId !== taskId &&
    mandateIsKindOf(nearest.mandateId, supervisorMandate)
  )
    return { kind: "supervisor", rootTaskId: nearest.rootTaskId };
  const author = taskAuthorOf(task);
  if (author.kind === "agent") {
    const filer = await getConversation(author.conversationId);
    // The CHECK ties an agent author to a conversation; a conversation row
    // gone (deleted) leaves the task to a person.
    if (filer !== null) return { kind: "filer", taskId: filer.taskId };
  }
  return {
    kind: "person",
    label: author.kind === "system" ? "the system" : "a person",
  };
}

/** Whether `conversationId` acts as `owner`. */
export async function actsAsOwner(
  conversationId: string,
  owner: TaskOwnership,
): Promise<boolean> {
  switch (owner.kind) {
    case "claimed":
      return owner.owns(conversationId);
    case "supervisor":
    case "filer": {
      const conversation = await getConversation(conversationId);
      const ownerTask =
        owner.kind === "supervisor" ? owner.rootTaskId : owner.taskId;
      return conversation?.taskId === ownerTask;
    }
    case "person":
      return false;
  }
}

/** The owner in words, for a refusal: "filed by a person". */
export function describeOwner(owner: TaskOwnership): string {
  switch (owner.kind) {
    case "claimed":
      return `owned by ${owner.label}`;
    case "supervisor":
      return `owned by the supervisor of task ${owner.rootTaskId}`;
    case "filer":
      return `filed by the agent of task ${owner.taskId}`;
    case "person":
      return `filed by ${owner.label}`;
  }
}
