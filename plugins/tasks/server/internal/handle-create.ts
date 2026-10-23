import {
  _tasks,
  taskAttachments,
  addTaskDependency,
  createTask,
  getTask,
} from "@plugins/tasks/plugins/tasks-core/server";
import { rankAfterSibling } from "@plugins/primitives/plugins/rank/server";
import { scheduleTaskTitleUpdate } from "@plugins/tasks/plugins/task-title/server";
import { synthesiseTitleFallback } from "@plugins/tasks/plugins/task-title/core";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { createTask as createTaskEndpoint } from "../../core/endpoints";
import { armTaskAutoStart } from "./arm-auto-start";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  DEFAULT_MODEL_CHOICE,
  assertChoiceLaunchable,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";

export const handleCreate = implement(createTaskEndpoint, async ({ body }) => {
  // Before the task is filed, so a model this machine cannot run (unknown, or
  // retired) is a 400 that leaves nothing behind.
  const autoStartModel = body.autoStart
    ? (body.autoStart.model ?? DEFAULT_MODEL_CHOICE)
    : undefined;
  if (autoStartModel !== undefined)
    assertChoiceLaunchable(autoStartModel, getModelCatalog());
  const description = body.description?.trim() || null;
  const explicitTitle = body.title?.trim();
  // Use the synthesised fallback as the initial title so creation is instant;
  // Haiku then upgrades it asynchronously via scheduleTaskTitleUpdate.
  const fallbackTitle = description
    ? synthesiseTitleFallback(description)
    : null;
  const title = explicitTitle ?? fallbackTitle ?? "Untitled";
  const folderId = body.folderId ?? null;
  // Positional intent wins over a plain append: only the server can interpolate
  // against the complete sibling set (the client may hold a filtered view).
  const rank = body.afterId
    ? await rankAfterSibling(
        _tasks,
        _tasks.folderId,
        folderId,
        body.afterId,
        _tasks.id,
      )
    : body.rank
      ? Rank.from(body.rank)
      : undefined;
  const row = await createTask({
    folderId,
    title,
    // A caller-supplied title is human-authored; a synthesised fallback is not.
    titleAuto: !explicitTitle,
    description,
    author: body.author ?? "user",
    rank,
  });

  if (!explicitTitle && description && fallbackTitle) {
    scheduleTaskTitleUpdate(row.id, description, fallbackTitle);
  }

  if (Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0) {
    await taskAttachments.set(row.id, body.attachmentIds);
  }

  const dependencies = Array.isArray(body.dependencies)
    ? Array.from(
        new Set(
          body.dependencies.filter(
            (d): d is string =>
              typeof d === "string" && d.length > 0 && d !== row.id,
          ),
        ),
      )
    : [];

  for (const depId of dependencies) {
    try {
      await addTaskDependency(row.id, depId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bad request";
      const status = msg.includes("not found") ? 404 : 400;
      throw new HttpError(status, msg);
    }
  }

  if (autoStartModel !== undefined) {
    await armTaskAutoStart({
      taskId: row.id,
      model: autoStartModel,
      cause: "user-launch",
    });
    // Re-fetch so the response reflects the autoStart columns and any
    // dependencies we just wrote.
    const fresh = await getTask(row.id);
    return fresh ?? row;
  }

  if (dependencies.length > 0) {
    const fresh = await getTask(row.id);
    return fresh ?? row;
  }

  return row;
});
