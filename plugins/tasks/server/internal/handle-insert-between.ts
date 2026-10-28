import { interactivePlacement } from "./placement";
import {
  createTask,
  getTask,
  removeTaskDependency,
  addTaskDependency,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { insertTaskBetween } from "../../core/endpoints";

export const handleInsertBetween = implement(insertTaskBetween, async ({ body }) => {
  const { sourceTaskId, targetTaskId, targetFolderId } = body;

  const [sourceTask, targetTask] = await Promise.all([
    getTask(sourceTaskId),
    getTask(targetTaskId),
  ]);

  const groupId = sourceTask?.groupId ?? targetTask?.groupId ?? null;

    // One transaction with net status emits — the whole insert (create + rewire)
    // commits atomically and the change-feed coalesces the UI notify at commit,
    // so no separate withNotifyBatch is needed.
    return withTaskStatusBatch(async (tx) => {
      const row = await createTask(
        {
          ...interactivePlacement(targetFolderId),
          groupId,
          title: "Untitled",
          author: "user",
        },
        tx,
      );
      await removeTaskDependency(targetTaskId, sourceTaskId, tx);
      await addTaskDependency(targetTaskId, row.id, tx);
      return row;
    });
  },
);
