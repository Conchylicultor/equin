import { defineHostService } from "@plugins/framework/plugins/server-core/core";

/**
 * Who upgrades a task's title from its description — a model call, so it needs
 * the computer: the desktop's provider (`task-title#machine`) asks Haiku for
 * both titles in the background. A host without a model provides it as
 * nothing to do (`task-title/plugins/filed-titles`): every task keeps the title
 * it was filed with, exactly what the desktop shows when a generation fails.
 *
 * Fire-and-forget by contract: a task is filed with
 * `synthesiseTitleFallback(description)` first, so creating one never waits on
 * the model, and a generation that fails leaves that title standing.
 */
export interface TaskTitleGeneratorImpl {
  /**
   * Replace `fallbackTitle` (the title the task was just filed with) by a
   * generated one, unless the user renamed it meanwhile.
   */
  scheduleUpdate(
    taskId: string,
    description: string,
    fallbackTitle: string,
  ): void;
}

export const TaskTitleGenerator = defineHostService<TaskTitleGeneratorImpl>(
  "task-title.generator",
);

/** Upgrade a just-filed task's fallback title in the background (see {@link TaskTitleGeneratorImpl}). */
export function scheduleTaskTitleUpdate(
  taskId: string,
  description: string,
  fallbackTitle: string,
): void {
  TaskTitleGenerator.get().scheduleUpdate(taskId, description, fallbackTitle);
}
