import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { scheduleTaskTitleUpdate } from "@plugins/tasks/plugins/task-title/server";
import { synthesiseTitleFallback } from "@plugins/tasks/plugins/task-title/core";
import type { CreatePromptBlockTaskBody } from "../../shared/endpoints";
import { promptBlock } from "./tables";

// The category prompt-launched tasks are stamped with; the plugin contributes
// the matching TaskCategory registration from its barrel.
export const PAGES_CATEGORY_ID = "pages";

// The page/block a task was launched from, or undefined when the task did not
// come from a prompt block.
export async function getPromptTaskOrigin(taskId: string) {
  return promptBlock.get(taskId);
}

// Create a task from a prompt block's text and stamp its provenance. Mirrors the
// task-creation block of `handleCreateChain` (instant synthesised title, Haiku
// upgrade scheduled in the background) plus `registerReportsInvestigation`'s
// create-then-stamp pattern.
//
// The link row is the SINGLE SOURCE OF TRUTH for the block↔task relation — the
// block never stores task ids in its `data`, so a deleted task disappears from
// the block automatically (FK CASCADE on the task) and the two cannot drift.
export async function createTaskFromPromptBlock(
  body: CreatePromptBlockTaskBody,
): Promise<{ taskId: string }> {
  const fallbackTitle = synthesiseTitleFallback(body.prompt);
  const task = await createTask({
    title: fallbackTitle,
    // Synthesised summary, upgraded by Haiku.
    titleAuto: true,
    description: body.prompt,
    author: "user",
  });
  scheduleTaskTitleUpdate(task.id, body.prompt, fallbackTitle);
  await setTaskCategory(task.id, PAGES_CATEGORY_ID);
  await promptBlock.upsert(task.id, { pageId: body.pageId, blockId: body.blockId });
  return { taskId: task.id };
}
