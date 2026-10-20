import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskTitleGenerator } from "@plugins/tasks/plugins/task-title/server";

export default {
  description:
    "The task titles of a host without a model: provides the TaskTitleGenerator host service as nothing to do — there is no Claude CLI to ask, so every task keeps the title it was filed with, the same title the desktop keeps when a generation fails (the browser composition, the portable boot test). Never booted by the desktop.",
  portable: true,
  contributions: [TaskTitleGenerator.provide({ scheduleUpdate: () => {} })],
} satisfies ServerPluginDefinition;
