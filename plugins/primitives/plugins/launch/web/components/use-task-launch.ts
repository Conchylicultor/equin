import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import type { MachineResult } from "@plugins/infra/plugins/endpoints/core";
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
import type { LaunchOptionDef } from "@plugins/tasks/plugins/launch-options/core";
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
  /**
   * Launch options the HOST sets on the task itself (before the launch), so
   * they are never sent: sending the user's value — or its default — would
   * overwrite the host's. See `LaunchAgentFormProps.ownedOptions`.
   */
  ownedOptions?: readonly LaunchOptionDef<unknown>[];
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
 *
 * Launching needs the computer (`launchTask` is `needsMachine`): `availability`
 * says whether this subtree can, for the host to disable its control with the
 * message before a click, and `launch` answers the `MachineResult`.
 */
export function useTaskLaunch({
  openAfterLaunch = false,
  openMode = "push",
  ownedOptions = [],
}: UseTaskLaunchOptions = {}) {
  const defaults = useLaunchOptionDefaults();
  const owned = new Set(ownedOptions.map((o) => o.id));
  const registered = TaskLaunch.Option.useContributions().filter(
    (o) => !owned.has(o.id),
  );
  const openPane = useOpenPane();
  const fetchEndpoint = useFetchEndpoint();
  const availability = useMachineAvailability(launchTask);

  const resolveOptions = (picked: LaunchOptionValues): LaunchOptionValues => ({
    ...defaults,
    ...picked,
  });

  const launch = async (
    prompt: string,
    picked: LaunchOptionValues,
    task: TaskLaunchTarget,
  ): Promise<MachineResult<LaunchTaskResponse>> => {
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
    if (result.kind === "ok" && result.value.started && openAfterLaunch)
      openPane(
        conversationPane,
        { convId: result.value.conversation.id },
        { mode: openMode },
      );
    return result;
  };

  return { resolveOptions, launch, availability };
}
