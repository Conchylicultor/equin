/**
 * The `edit_task` / `drop_task` policy, granted by `tasks.manage`: which tasks
 * a caller may touch — the tasks of ITS mandate's tree, below the root — and
 * the edit or drop itself through ports, so a test drives it over an
 * in-memory store (`manage-tasks.test.ts`).
 *
 * "Its tree" is every task whose nearest mandate is the caller's: a task
 * elsewhere, the mandate's own root (the caller's task), or a nested subtree
 * that names a mandate of its own is refused. Every id an edit names — the
 * task and both ends of each dependency — is checked before anything is
 * written, and the write is one transaction, so a refused edit changes
 * nothing.
 *
 * `start` decides how the task launches: `armed` queues it for auto-start
 * (it launches once nothing it runs after is unresolved), whatever its track
 * — a sidequest is never armed when filed, but its supervisor may start it
 * here; `manual` disarms it, leaving the launch to a person.
 *
 * `track` moves the task between the main track and the sidequests. Arming
 * never changes it: a sidequest repurposed into critical-path work stays a
 * sidequest until an edit says `track: "main"`. When both are given, the
 * default model of an arm is the NEW track's.
 */

import {
  assertChoiceLaunchable,
  type ModelCatalog,
  type ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import type { TaskTrack } from "@plugins/tasks/plugins/task-track/core";
import { formatManageAnswer } from "../../core";

export const EDIT_STARTS = ["armed", "manual"] as const;
export type EditStart = (typeof EDIT_STARTS)[number];

export interface EditTaskInput {
  task_id: string;
  title?: string;
  description?: string | null;
  add_after?: string[];
  remove_after?: string[];
  start?: EditStart;
  /** The model an armed task launches with; absent = the default for the
   * task. Only with `start: "armed"`. */
  model?: ModelChoice;
  /** Move the task to this track; absent = its track is unchanged. */
  track?: TaskTrack;
}

export interface DropTaskInput {
  task_id: string;
}

/** What one edit writes, validated. */
export interface TaskEdit {
  taskId: string;
  title?: string;
  description?: string | null;
  addAfter: string[];
  removeAfter: string[];
  /** Arm with this model, or disarm; absent = how it starts is unchanged. */
  start?: { kind: "armed"; model: ModelChoice } | { kind: "manual" };
  /** The track to set; absent = unchanged. */
  track?: TaskTrack;
}

export type ManageRefusal =
  | "no-tree"
  | "not-found"
  | "not-in-tree"
  | "root"
  | "empty"
  | "conflict"
  | "not-armable";

export type ManageOutcome =
  | { kind: "edited"; taskId: string; changed: string[] }
  | { kind: "dropped"; taskId: string }
  | { kind: "refused"; reason: ManageRefusal; message: string };

export interface ManageTasksPorts {
  /** The root task of the caller's mandate tree, or `null` when its
   * conversation has no task or no mandate. */
  callerRoot: (conversationId: string) => Promise<string | null>;
  /** The root task of `taskId`'s mandate tree — `{ kind: "not-found" }` for
   * an id no task has. */
  rootOf: (
    taskId: string,
  ) => Promise<
    | { kind: "found"; rootTaskId: string }
    | { kind: "none" }
    | { kind: "not-found" }
  >;
  /** Why `taskId` cannot be armed (dropped, or an open attempt already IS
   * its launch), or `null` when it can. */
  unarmable: (taskId: string) => Promise<string | null>;
  /** The task's current track. */
  trackOf: (taskId: string) => Promise<TaskTrack>;
  /** The model an armed task on `track` launches with when the caller names
   * none. */
  defaultModel: (
    conversationId: string,
    track: TaskTrack,
  ) => Promise<ModelChoice>;
  /** The live model catalog a `model` is checked against. */
  modelCatalog: () => ModelCatalog;
  /** Writes the whole edit at once (the start last, so a launch sees the new
   * dependencies); `{ ok: false }` when the graph refuses it (a dependency
   * cycle) — nothing written. */
  apply: (
    edit: TaskEdit,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  drop: (taskId: string) => Promise<void>;
}

function refused(reason: ManageRefusal, message: string): ManageOutcome {
  return { kind: "refused", reason, message };
}

/** Every id must be a task of the caller's tree, below its root. */
async function checkInTree(
  conversationId: string,
  ids: string[],
  ports: ManageTasksPorts,
): Promise<ManageOutcome | null> {
  const root = await ports.callerRoot(conversationId);
  if (root === null)
    return refused("no-tree", "Your conversation has no task tree.");
  for (const id of new Set(ids)) {
    if (id === root)
      return refused(
        "root",
        `${id} is your tree's root (your own task) — only the tasks below it can be edited or dropped.`,
      );
    const of = await ports.rootOf(id);
    if (of.kind === "not-found") return refused("not-found", `No task ${id}.`);
    if (of.kind === "none" || of.rootTaskId !== root)
      return refused(
        "not-in-tree",
        `${id} is not in your task tree (root ${root}) — you may only edit or drop the tasks of your own tree.`,
      );
  }
  return null;
}

export async function editTask(
  input: EditTaskInput,
  conversationId: string,
  ports: ManageTasksPorts,
): Promise<ManageOutcome> {
  const taskId = input.task_id.trim();
  const addAfter = [...new Set((input.add_after ?? []).map((s) => s.trim()))];
  const removeAfter = [
    ...new Set((input.remove_after ?? []).map((s) => s.trim())),
  ];
  const changed = [
    ...(input.title !== undefined ? ["title"] : []),
    ...(input.description !== undefined ? ["description"] : []),
    ...(addAfter.length > 0 ? ["add_after"] : []),
    ...(removeAfter.length > 0 ? ["remove_after"] : []),
    ...(input.track !== undefined ? [`track ${input.track}`] : []),
    ...(input.start !== undefined ? [`start ${input.start}`] : []),
  ];
  if (input.model !== undefined && input.start !== "armed")
    return refused(
      "conflict",
      '`model` is the model an armed task launches with: pass it with start "armed".',
    );
  if (changed.length === 0)
    return refused(
      "empty",
      "Nothing to change: pass title, description, add_after, remove_after, track or start.",
    );
  const both = addAfter.filter((id) => removeAfter.includes(id));
  if (both.length > 0)
    return refused(
      "conflict",
      `${both.join(", ")} is in both add_after and remove_after.`,
    );
  if (addAfter.includes(taskId))
    return refused("conflict", "A task cannot run after itself.");

  const scope = await checkInTree(
    conversationId,
    [taskId, ...addAfter, ...removeAfter],
    ports,
  );
  if (scope) return scope;

  let start: TaskEdit["start"];
  if (input.start === "armed") {
    const why = await ports.unarmable(taskId);
    if (why !== null) return refused("not-armable", why);
    const model =
      input.model ??
      (await ports.defaultModel(
        conversationId,
        input.track ?? (await ports.trackOf(taskId)),
      ));
    // The schema checks only the id grammar: whether this machine can run the
    // version is the live catalog's answer, listed in the refusal.
    assertChoiceLaunchable(model, ports.modelCatalog());
    start = { kind: "armed", model };
  } else if (input.start === "manual") {
    start = { kind: "manual" };
  }

  const out = await ports.apply({
    taskId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    addAfter,
    removeAfter,
    ...(start ? { start } : {}),
    ...(input.track !== undefined ? { track: input.track } : {}),
  });
  if (!out.ok) return refused("conflict", out.message);
  return { kind: "edited", taskId, changed };
}

export async function dropTask(
  input: DropTaskInput,
  conversationId: string,
  ports: ManageTasksPorts,
): Promise<ManageOutcome> {
  const taskId = input.task_id.trim();
  const scope = await checkInTree(conversationId, [taskId], ports);
  if (scope) return scope;
  await ports.drop(taskId);
  return { kind: "dropped", taskId };
}

export function renderManageOutcome(out: ManageOutcome): string {
  return formatManageAnswer(
    out.kind === "refused" ? { kind: "refused", message: out.message } : out,
  );
}
