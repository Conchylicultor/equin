import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { getConfig } from "@plugins/config_v2/server";
import {
  assertChoiceLaunchable,
  normalizeModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { threadResultReply } from "@plugins/conversations/plugins/agent-thread/core";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { armTaskAutoStart } from "@plugins/tasks/server";
import { WISHES_CATEGORY_ID } from "@plugins/wish/core";
import {
  AskFiledTaskSchema,
  FILE_TASK_TOOL,
  HELP_ASK_PROFILE,
  askConfig,
  askFiledTask,
} from "../../core";

/**
 * The help agent's one way to get something done: file a task that launches
 * now. Reserved to the `help.ask` profile — no other conversation lists it.
 *
 * Unlike `add_task`, the task hangs off nothing: no folder, no dependency
 * edges (so dropping the help task — Done — leaves it running), and none of
 * the help task's launch options (so it runs in the default workspace, a
 * worktree, not the help agent's read-only scratch one). It is on the main
 * track (no track row), filed under Improvements — where the Improve button
 * files — authored by the help conversation, and armed with the configured
 * model, which wakes the launcher at once since nothing blocks it.
 *
 * It answers the task's id (`threadResultReply`), which the thread's card
 * reads back off the call's result to show the live task.
 */
export const fileTaskTool = Mcp.tool({
  name: FILE_TASK_TOOL,
  profiles: [HELP_ASK_PROFILE],
  description: `File a task for something the user wants changed or added in equin, or something broken: an agent starts on it at once, in its own worktree, and the task shows in the user's thread. Title and description state the PROBLEM or WISH and what you found, not how to build it. Call it once per wish. It answers the filed task's id; then tell the user in one sentence that it is filed — the task shows in their thread, an agent already on it.`,
  inputSchema: AskFiledTaskSchema.shape,
  async handler({ title, description }, { conversationId }) {
    // Before anything is written: a model this machine cannot run fails the
    // call (and the agent says so) rather than leaving an armed task that
    // never launches.
    const model = normalizeModelChoice(getConfig(askConfig).taskModel);
    assertChoiceLaunchable(model, getModelCatalog());
    const task = await createTask({
      title,
      titleAuto: false,
      description,
      author: conversationId,
    });
    await setTaskCategory(task.id, WISHES_CATEGORY_ID);
    await armTaskAutoStart({ taskId: task.id, model, cause: "help-ask" });
    return threadResultReply(askFiledTask, { taskId: task.id });
  },
});
