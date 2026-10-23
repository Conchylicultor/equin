import {
  taskAttachments,
  addTaskDependency,
  createTask,
  getTask,
} from "@plugins/tasks/plugins/tasks-core/server";
import { scheduleTaskTitleUpdate } from "@plugins/tasks/plugins/task-title/server";
import { synthesiseTitleFallback } from "@plugins/tasks/plugins/task-title/core";
import { getAttachment } from "@plugins/infra/plugins/attachments/server";
import {
  attachmentMarkdown,
  extractAttachmentIds,
} from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import { type TaskChainCard } from "../../core/task-chain-types";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { createTaskChain } from "../../core/endpoints";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import { resolveLaunchOptions } from "@plugins/tasks/plugins/launch-options/server";
import { rewireDependencies } from "./rewire-dependencies";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { setTaskSourceUrl } from "@plugins/tasks/plugins/task-source-url/server";

export const handleCreateChain = implement(
  createTaskChain,
  async ({ body }) => {
    // `folder` targets nest under an existing task; `category`/`root` targets
    // create root tasks (a category is a stamped dimension, not a parent — every
    // card in the chain shares it, mirroring the shared folder).
    const folderId =
      body.target.kind === "folder" ? body.target.folderTaskId : null;
    const categoryId =
      body.target.kind === "category" ? body.target.categoryId : null;

    if (folderId) {
      // Verify the folder task exists.
      const folderTask = await getTask(folderId);
      if (!folderTask) {
        throw new HttpError(400, `folder task ${folderId} not found`);
      }
    }

    // Verify relate.taskId exists upfront so we don't half-create the chain
    // before discovering it's invalid.
    if (body.relate) {
      const rel = await getTask(body.relate.taskId);
      if (!rel) {
        throw new HttpError(400, `relate task ${body.relate.taskId} not found`);
      }
    }

    if (body.relate?.mode === "followup" && body.relate.insertBefore?.length) {
      for (const depId of body.relate.insertBefore) {
        const dep = await getTask(depId);
        if (!dep) {
          throw new HttpError(400, `insertBefore: task ${depId} not found`);
        }
        if (!dep.dependencies.includes(body.relate.taskId)) {
          throw new HttpError(
            400,
            `insertBefore: task ${depId} does not depend on ${body.relate.taskId}`,
          );
        }
      }
    }

    // Pre-resolve all attachments so a missing reference fails fast (improve's
    // existing invariant — partial chains leave dangling refs).
    const cardAttachments: { id: string; filename: string }[][] = [];
    for (let i = 0; i < body.cards.length; i++) {
      const card = body.cards[i]!;
      const ids = card.attachmentIds ?? [];
      const resolved: { id: string; filename: string }[] = [];
      for (const id of ids) {
        const row = await getAttachment(id);
        if (!row) {
          throw new HttpError(400, `card ${i}: attachment ${id} not found`);
        }
        resolved.push(row);
      }
      cardAttachments.push(resolved);
    }

    // Same fail-fast invariant for launch options: resolve every value against
    // its registered option BEFORE any task exists, so an unknown id or a bad
    // value can't leave half a chain behind.
    const cardLaunchValues = body.cards.map((card, i) =>
      resolveLaunchOptions(card.options ?? {}, `card ${i}`),
    );

    const author = body.target.kind === "category" ? "improve-plugin" : "user";
    const groupId = body.relate ? body.relate.taskId : null;
    const taskIds: string[] = [];

    await withNotifyBatch(async () => {
      for (let i = 0; i < body.cards.length; i++) {
        const card = body.cards[i]!;
        const isHead = i === 0;
        const attachments = cardAttachments[i]!;

        const description = renderTaskDescription({
          text: card.text,
          url: card.url ?? "",
          attachments,
        });

        const fallbackTitle = synthesiseTitleFallback(card.text);
        const newTask = await createTask({
          folderId,
          groupId,
          title: fallbackTitle,
          // Draft-form titles are always a synthesised summary, upgraded by Haiku.
          titleAuto: true,
          description,
          author,
        });
        scheduleTaskTitleUpdate(newTask.id, card.text, fallbackTitle);
        taskIds.push(newTask.id);

        if (categoryId) {
          await setTaskCategory(newTask.id, categoryId);
        }

        // Stored as data too, not only as the prompt's `**URL:**` line, so
        // "Open app" can land on the page without parsing the description.
        if (card.url) {
          await setTaskSourceUrl(newTask.id, card.url);
        }

        if (attachments.length > 0) {
          await taskAttachments.add(
            newTask.id,
            attachments.map((a) => a.id),
          );
        }

        if (isHead && body.relate) {
          const selective =
            body.relate.mode === "followup" && body.relate.insertBefore
              ? body.relate.insertBefore
              : undefined;
          await rewireDependencies({
            newTaskId: newTask.id,
            targetId: body.relate.taskId,
            relation: body.relate.mode,
            selectiveInsertBefore: selective,
            standalone: body.relate.standalone,
          });
        }
        if (!isHead && card.linkedToPrev !== false) {
          await addTaskDependency(newTask.id, taskIds[i - 1]!);
        }

        // Applied last: the dependencies above are already written, so an option
        // that gates on them (auto-start) sees the task's real blocking set.
        // `queued`: nothing here starts the task — the queue does, once its
        // dependencies clear.
        for (const { entry, value } of cardLaunchValues[i]!) {
          await entry.apply(
            { taskId: newTask.id, cause: "user-launch", start: "queued" },
            value,
          );
        }
      }
    });

    return { taskIds };
  },
);

function renderTaskDescription(opts: {
  text: string;
  url: string;
  attachments: { id: string; filename: string }[];
}): string {
  // Attachments already referenced inline in the text are intentionally omitted
  // from the explicit section — they're visible where the user placed them and
  // a second copy would confuse the agent.
  const inlineIds = new Set(extractAttachmentIds(opts.text));
  const extraAttachments = opts.attachments.filter((a) => !inlineIds.has(a.id));

  const hasContext = opts.url || extraAttachments.length > 0;
  if (!hasContext) return opts.text;

  const lines: string[] = [opts.text, "", "---"];
  if (opts.url) lines.push(`**URL:** ${opts.url}`);
  if (extraAttachments.length > 0) {
    lines.push("**Attachments:**");
    for (const att of extraAttachments) {
      lines.push(`- ${attachmentMarkdown(att.id, att.filename)}`);
    }
  }
  return lines.join("\n");
}

// Re-exported for clarity in tests / other server modules that want the type.
export type { TaskChainCard };
