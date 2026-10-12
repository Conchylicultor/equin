import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ModelChoiceSchema } from "@plugins/conversations/plugins/model-provider/core";
import { dateString } from "@plugins/infra/plugins/endpoints/core";
import { ConversationSchema } from "@plugins/tasks/plugins/tasks-core/core";
import {
  TaskChainSubmitBodySchema,
  TaskChainSubmitResponseSchema,
} from "./task-chain-types";

// --- Body schemas ---

export const CreateTaskBodySchema = z.object({
  folderId: z.string().nullable().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  author: z.string().optional(),
  rank: z.string().optional(),
  // Positional intent: place the new task immediately after this sibling.
  // Resolved server-side against the complete sibling set (see rankAfterSibling)
  // and takes precedence over `rank` / plain append.
  afterId: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  autoStart: z
    .object({
      model: ModelChoiceSchema.optional(),
    })
    .optional(),
  attachmentIds: z.array(z.string()).optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;

// No `rank`: a task's position is only ever set through `moveTask` below, which
// carries positional intent. `folderId` stays here for a plain re-file that
// makes no positional claim (the task appends at the end of its new folder).
export const UpdateTaskBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  drop: z.boolean().optional(),
  hold: z.boolean().optional(),
  folderId: z.string().nullable().optional(),
});
export type UpdateTaskBody = z.infer<typeof UpdateTaskBodySchema>;

/**
 * Positional intent, never a rank (see `CreateTaskBodySchema.afterId`). The
 * task lands among `folderId`'s children, immediately `zone` of `targetId`.
 *
 * `targetId: null` addresses the sibling-list boundary instead of a neighbour:
 * `"after"` appends at the end of the folder, `"before"` prepends at the start.
 * That is what a tree "drop onto this row as a child" gesture means.
 */
export const MoveTaskBodySchema = z.object({
  folderId: z.string().nullable(),
  targetId: z.string().nullable(),
  zone: z.enum(["before", "after"]),
});
export type MoveTaskBody = z.infer<typeof MoveTaskBodySchema>;

export const InsertBetweenBodySchema = z.object({
  sourceTaskId: z.string(),
  targetTaskId: z.string(),
  targetFolderId: z.string().nullable().optional(),
});
export type InsertBetweenBody = z.infer<typeof InsertBetweenBodySchema>;

export const SetAutoStartBodySchema = z.object({
  model: ModelChoiceSchema,
});
export type SetAutoStartBody = z.infer<typeof SetAutoStartBodySchema>;

export const AddDependencyBodySchema = z.object({
  dependsOnTaskId: z.string().min(1),
});
export type AddDependencyBody = z.infer<typeof AddDependencyBodySchema>;

// Move an existing task node within the dependency TREE. `newParentId === null`
// heals the moved task to a root; `"splice"` inserts it into the chain (the new
// parent's old children rewire onto it); `"branch"` hangs it as a parallel child.
export const DepsMoveBodySchema = z.object({
  newParentId: z.string().nullable(),
  mode: z.enum(["splice", "branch"]),
});
export type DepsMoveBody = z.infer<typeof DepsMoveBodySchema>;

// File a task with its launch options, then start it now. `task` names the
// task to launch: an existing one by id, or a new one to file under a category.
export const LaunchTaskBodySchema = z.object({
  prompt: z.string().min(1),
  // Contributed launch-option values, keyed by option id — the same shape as a
  // chain card's `options` (see `TaskChainCardSchema`): the registry in
  // `tasks/launch-options` owns what an id means, and an unknown id is a 400.
  options: z.record(z.string(), z.unknown()),
  task: z.union([
    z.object({ id: z.string().min(1) }),
    z.object({ title: z.string().min(1), categoryId: z.string().min(1) }),
  ]),
});
export type LaunchTaskBody = z.infer<typeof LaunchTaskBodySchema>;

// `started: false` is a filed task that did not start — the drafted options
// left it unarmed (auto-start Off), or another runner launched it first.
export const LaunchTaskResponseSchema = z.discriminatedUnion("started", [
  z.object({ started: z.literal(true), conversation: ConversationSchema }),
  z.object({ started: z.literal(false), taskId: z.string() }),
]);
export type LaunchTaskResponse = z.infer<typeof LaunchTaskResponseSchema>;

// Wire-format response schema: plain JSON types (no Rank class, no Date class).
// Consumers that need the rich domain types should parse via TaskSchema locally.
export const TaskResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  folderId: z.string().nullable(),
  groupId: z.string().nullable(),
  rank: z.string(),
  active: z.boolean(),
  author: z.string().nullable(),
  createdAt: dateString(),
  updatedAt: dateString(),
  droppedAt: dateString().nullable(),
  heldAt: dateString().nullable(),
  finishedAt: dateString().nullable(),
  dependencies: z.array(z.string()),
});

// --- Endpoint definitions ---

export const listTasks = defineEndpoint({
  route: "GET /api/tasks",
  response: z.array(TaskResponseSchema),
});

export const createTask = defineEndpoint({
  route: "POST /api/tasks",
  body: CreateTaskBodySchema,
  response: TaskResponseSchema,
});

export const createTaskChain = defineEndpoint({
  route: "POST /api/tasks/chain",
  body: TaskChainSubmitBodySchema,
  response: TaskChainSubmitResponseSchema,
});

export const launchTask = defineEndpoint({
  route: "POST /api/tasks/launch",
  body: LaunchTaskBodySchema,
  response: LaunchTaskResponseSchema,
});

export const insertTaskBetween = defineEndpoint({
  route: "POST /api/tasks/insert-between",
  body: InsertBetweenBodySchema,
  response: TaskResponseSchema,
});

export const getTask = defineEndpoint({
  route: "GET /api/tasks/:id",
  response: TaskResponseSchema,
});

export const updateTask = defineEndpoint({
  route: "PATCH /api/tasks/:id",
  body: UpdateTaskBodySchema,
  response: TaskResponseSchema,
});

// Reposition a task in the FOLDER tree (the display hierarchy). The rank is
// minted server-side against the complete `folderId` sibling set, inside the
// write's own transaction — the tree that emits this drop only ever holds a
// projection. Returns nothing: the tasks live resource pushes the new order.
export const moveTask = defineEndpoint({
  route: "POST /api/tasks/:id/move",
  body: MoveTaskBodySchema,
});

export const setTaskAutoStart = defineEndpoint({
  route: "POST /api/tasks/:id/auto-start",
  body: SetAutoStartBodySchema,
});

export const clearTaskAutoStart = defineEndpoint({
  route: "DELETE /api/tasks/:id/auto-start",
});

export const addTaskDependency = defineEndpoint({
  route: "POST /api/tasks/:id/dependencies",
  body: AddDependencyBodySchema,
});

export const removeTaskDependency = defineEndpoint({
  route: "DELETE /api/tasks/:id/dependencies/:depId",
});

export const moveTaskInDepsTree = defineEndpoint({
  route: "POST /api/tasks/:id/deps-move",
  body: DepsMoveBodySchema,
});
