import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { LaunchAgentForm } from "@plugins/primitives/plugins/launch/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ConversationRow } from "@plugins/conversations/plugins/conversation-ui/plugins/row/web";
import { useTaskConversations } from "@plugins/tasks/plugins/tasks-core/web";
import { StatusBadge } from "@plugins/tasks/plugins/task-status/web";
import { useTodoTaskState, type TodoTaskState } from "../hooks";
import { dispatchTodoAgent } from "../internal/api";

/**
 * The TODO card's dispatch panel — what its glyph opens, and what its rail's
 * block-actions menu carries. ONE component registered twice, deliberately: the
 * rail is where a user looks for a block's actions, the glyph is where they look
 * for the glyph.
 *
 * Two states, and the second is the first plus a header rather than a different
 * surface: before a dispatch it is the launch form alone, after one it leads
 * with the task it created and the run to open, and the form below reads as
 * "dispatch another". That form is not a second way to do the same thing — the
 * endpoint returns the SAME task id, so using it adds an ATTEMPT to that task.
 */
export function TodoDispatch({
  blockId,
  close,
}: {
  blockId: string;
  /** Dismisses the popover this panel was opened in. */
  close: () => void;
}) {
  const state = useTodoTaskState(blockId);
  const fetchEndpoint = useFetchEndpoint();

  // Whether the card was dispatched decides what the panel offers ("Dispatch"
  // vs "Dispatch another" under its task), so neither is claimed before the
  // answer — and a failed read says so, with Retry.
  if (state.status === "loading") return <Loading variant="spinner" />;
  if (state.status === "error")
    return (
      <ResourceErrorInline
        variant="block"
        subject="the card's task"
        error={state.error}
        refetch={state.refetch}
      />
    );
  const dispatched = state.data;

  return (
    <Stack gap="md">
      {dispatched ? <DispatchedTask task={dispatched} onOpen={close} /> : null}
      <LaunchAgentForm
        draftKey={`todo-dispatch:${blockId}`}
        title={dispatched ? "Dispatch another agent" : "Dispatch an agent"}
        description={
          dispatched
            ? "Runs as another attempt on the same task, with the card as it reads now."
            : "The agent gets this card's contents and the page it lives on, and writes its findings back into the card."
        }
        // Both values come from the server: the task id it created or reused,
        // and the prompt it composed from the card's CURRENT contents. Composing
        // the prompt here would mean re-deriving the card's markdown from rows
        // whose `data.text` projection lags their content docs.
        getRequest={(context) =>
          dispatchTodoAgent(fetchEndpoint, blockId, context)
        }
        openAfterLaunch
        openMode="push"
        // The launched conversation opens in a column beside the page, so the
        // panel that opened it must get out of the way — on either outcome.
        onSubmitted={close}
      />
    </Stack>
  );
}

/**
 * The task this card is bound to: its live title and status, and a row opening
 * the newest run.
 *
 * Split into its own component so the `tasks` subscription is a hook on
 * something that only mounts once there IS a task — the panel's un-dispatched
 * state must not pay for it, and a hook cannot be called conditionally.
 */
function DispatchedTask({
  task,
  onOpen,
}: {
  task: TodoTaskState;
  /** Called once the row navigates, so the shell can dismiss its popover. */
  onOpen: () => void;
}) {
  return (
    <Stack gap="2xs">
      <Text variant="eyebrow" tone="muted">
        Dispatched
      </Text>
      <Line>
        <Fill>
          <Text variant="label">{task.title}</Text>
        </Fill>
        <StatusBadge status={task.status} />
      </Line>
      <LatestRun taskId={task.taskId} onOpen={onOpen} />
    </Stack>
  );
}

/**
 * The newest run, as a row that opens it.
 *
 * Its own component so that "the runs have not loaded yet" is an early return
 * HERE rather than a hole in the header above it: the task's title and status
 * come off a different resource and are ready first, and gating the whole
 * section on the runs would blink them.
 *
 * The run it offers comes from the ONE join the card's surfaces share, so it is
 * by construction the last of the chips at the card's foot rather than a second
 * answer computed here.
 */
function LatestRun({ taskId, onOpen }: { taskId: string; onOpen: () => void }) {
  const runs = useTaskConversations([taskId]);
  if (runs.status === "loading") return null;
  if (runs.status === "error") {
    return (
      <ResourceErrorInline
        error={runs.error}
        refetch={runs.refetch}
        variant="inline"
        subject="the latest run"
      />
    );
  }

  const latest = runs.data.at(-1);
  if (!latest) return null;

  return <ConversationRow conv={latest} layout="inline" onOpen={onOpen} />;
}
