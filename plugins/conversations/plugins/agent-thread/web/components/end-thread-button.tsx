import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { useConversation } from "@plugins/conversations/web";
import { dropAndExit } from "@plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/core";

export interface EndThreadButtonProps {
  conversationId: string;
  /** After the close landed — the host clears the thread it was showing. */
  onEnded?: () => void;
}

/**
 * Done: the user is finished with this thread — the `exit_clean` of the UI.
 * Closes the conversation and drops its task (the conversation view's
 * Drop & Close, `dropAndExit`: a scratch thread has no work to land, so its
 * task always drops), then hands back to the host through `onEnded`.
 *
 * Renders nothing until the conversation's row has arrived, and nothing once
 * it is closed (`done`) or gone — there is nothing left to end. A failure is
 * a toast; the thread stays as it was. Closing stops the agent, which needs
 * the computer: on a host without it (the demo) the button is disabled and
 * its tooltip says why.
 */
export function EndThreadButton({
  conversationId,
  onEnded,
}: EndThreadButtonProps) {
  const row = useConversation(conversationId);
  const close = useEndpointMutation(dropAndExit, {
    onSuccess: () => onEnded?.(),
    onError: (err) =>
      showToast({
        title: "Couldn't close the conversation",
        description: getEndpointErrorMessage(err),
        variant: "error",
      }),
  });
  if (row.status !== "ready" || row.data === null) return null;
  const { status } = row.data;
  if (status === "done" || status === "gone") return null;
  if (close.kind === "unavailable") {
    return (
      <Button variant="ghost" tooltip={close.message} disabled>
        Done
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      tooltip="Close the conversation and drop its task"
      loading={close.isPending}
      onClick={() => close.mutate({ params: { id: conversationId } })}
    >
      Done
    </Button>
  );
}
