import { useTaskLaunch } from "@plugins/primitives/plugins/launch/web";
import type { MachineResult } from "@plugins/infra/plugins/endpoints/core";
import { workspaceLaunchOption } from "@plugins/conversations/plugins/workspace/plugins/launch-option/core";
import { autoStartLaunchOption } from "@plugins/tasks/plugins/auto-start/plugins/launch-option/core";
import type { ModelChoice } from "@plugins/conversations/plugins/model-provider/core";

export interface StartThreadOptions {
  /** The scratch profile the agent runs under — the thread's kind. */
  profile: string;
  /** The task category the run's task is filed under (shown in the Agent Manager). */
  categoryId: string;
  /** The model the agent runs on. */
  model: ModelChoice;
}

export interface StartThreadRequest {
  /** The task's title, as the Agent Manager lists it. */
  title: string;
  /** The agent's first turn. */
  prompt: string;
  /** The profile's input (validated by the profile's own schema on the server). */
  input?: unknown;
}

/** What a start answers: the conversation the run started. */
export type StartThreadResult = MachineResult<{ conversationId: string }>;

/**
 * Starts a run: files a task under the host's category and launches it now
 * under the host's scratch profile and model — the user's other launch
 * defaults (preprompt, effort) apply as for any launch. Nothing opens: the
 * host shows the run in its own `<AgentThread>`.
 *
 * `availability` is `useTaskLaunch`'s (launching needs the computer), for the
 * host to disable its control before a click.
 */
export function useStartThread({
  profile,
  categoryId,
  model,
}: StartThreadOptions) {
  const { launch, availability } = useTaskLaunch({ openAfterLaunch: false });

  const start = async ({
    title,
    prompt,
    input = {},
  }: StartThreadRequest): Promise<StartThreadResult> => {
    const result = await launch(
      prompt,
      {
        [workspaceLaunchOption.id]: { kind: "scratch", profile, input },
        [autoStartLaunchOption.id]: model,
      },
      { title, categoryId },
    );
    if (result.kind !== "ok") return result;
    if (!result.value.started)
      throw new Error(
        `[agent-thread] the ${profile} run was filed but not started (task ${result.value.taskId})`,
      );
    return {
      kind: "ok",
      value: { conversationId: result.value.conversation.id },
    };
  };

  return { start, availability };
}
