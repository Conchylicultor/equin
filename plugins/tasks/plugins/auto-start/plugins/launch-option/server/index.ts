import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskLaunchServer } from "@plugins/tasks/plugins/launch-options/server";
import { armTaskAutoStart } from "@plugins/tasks/server";
import { setTaskAutoStart } from "@plugins/tasks/plugins/auto-start/server";
import { assertChoiceLaunchable } from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { autoStartLaunchOption } from "../core";

export default {
  description:
    "Applies a drafted auto-start model to a newly created task: arms the launch (enqueuing immediately when nothing blocks it), only records the model when the host starts the task inline itself, or clears the marker when the draft says Off.",
  contributions: [
    TaskLaunchServer({
      def: autoStartLaunchOption,
      // The schema checks the id grammar; whether this machine can run the
      // version is the live catalog's answer — a retired or unknown one is a
      // 400 before the task is filed.
      validate: (model) => {
        if (model) assertChoiceLaunchable(model, getModelCatalog());
      },
      apply: async ({ taskId, cause, start }, model) => {
        if (!model) {
          await setTaskAutoStart(taskId, null);
          return;
        }
        // The caller claims this arm itself right after we return (the launch
        // popover's inline start): record the model on the marker, but do NOT
        // enqueue — a queued `tasks.maybe-launch` would race the caller's claim.
        if (start === "now") {
          await setTaskAutoStart(taskId, { model });
          return;
        }
        // Arming (not a bare `setTaskAutoStart`) is what actually enqueues the
        // launch when no dependency blocks the task.
        await armTaskAutoStart({ taskId, model, cause });
      },
      // NO `inherit`, deliberately — and the omission is the declaration. This
      // apply ARMS a launch, so inheriting it would start an agent for every
      // task an agent files (including `propose_task` drafts, which are meant
      // to wait for the user to accept them). Each filing tool decides
      // auto-start explicitly instead.
    }),
  ],
} satisfies ServerPluginDefinition;
