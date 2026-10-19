import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { DEMO_STORIES, demoTaskId } from "../core";

/**
 * The demo's starting data, written through the real mutations onto the
 * freshly migrated database: one task per story, under the same id the pack
 * answers (`task-demo-<key>`), and its category.
 */
export async function seed(): Promise<void> {
  for (const story of DEMO_STORIES) {
    const id = demoTaskId(story);
    await createTask({ id, title: story.task, titleAuto: false });
    if (story.category !== undefined) await setTaskCategory(id, story.category);
  }
}
