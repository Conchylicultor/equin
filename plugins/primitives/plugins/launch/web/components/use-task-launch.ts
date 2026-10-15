import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  useOpenPane,
  type PaneOpenMode,
} from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import {
  TaskLaunch,
  pickKnownOptions,
  useLaunchOptionDefaults,
  type LaunchOptionValues,
} from "@plugins/tasks/plugins/launch-options/web";
import { launchTask, type LaunchTaskResponse } from "@plugins/tasks/core";
import type { TaskSubject } from "@plugins/tasks/plugins/task-subject/core";

/** The task a launch runs: one that exists, or a new one filed under a category. */
export type TaskLaunchTarget =
  { id: string } | { title: string; categoryId: string; subject?: TaskSubject };

export interface UseTaskLaunchOptions {
  /** Whether a launch that started also OPENS its conversation. Default `false`. */
  openAfterLaunch?: boolean;
  /** Where that conversation opens, when it does. Default `"push"`. */
  openMode?: PaneOpenMode;
}

/**
 * The launch half every task-launch surface shares — the launch popover's form
 * and the agent manager's home prompt alike.
 *
 * `resolveOptions` reads the options the user picked through to the registry's
 * defaults, so an option registered after mount is still sent with its seed and
 * a host stores only what the user changed. `launch` files the task carrying
 * those options and starts it now (`POST /api/tasks/launch`), then opens the
 * conversation it started when the host asked for that. `started: false` comes
 * back as an outcome, not a failure: the user picked Off on the run pill.
 */
export function useTaskLaunch({
  openAfterLaunch = false,
  openMode = "push",
}: UseTaskLaunchOptions = {}) {
  const defaults = useLaunchOptionDefaults();
  const registered = TaskLaunch.Option.useContributions();
  const openPane = useOpenPane();

  const resolveOptions = (picked: LaunchOptionValues): LaunchOptionValues => ({
    ...defaults,
    ...picked,
  });

  const launch = async (
    prompt: string,
    picked: LaunchOptionValues,
    task: TaskLaunchTarget,
  ): Promise<LaunchTaskResponse> => {
    const result = await fetchEndpoint(
      launchTask,
      {},
      {
        body: {
          prompt,
          options: pickKnownOptions(resolveOptions(picked), registered),
          task,
        },
      },
    );
    if (result.started && openAfterLaunch)
      openPane(
        conversationPane,
        { convId: result.conversation.id },
        { mode: openMode },
      );
    return result;
  };

  return { resolveOptions, launch };
}
