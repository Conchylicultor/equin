import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { useConversation } from "@plugins/conversations/web";
import { dropAndExit } from "@plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/core";

const closeIcon = symbol("close");

export interface EndThreadButtonProps {
  conversationId: string;
  /** After the close landed — the host clears the thread it was showing. */
  onEnded?: () => void;
}

/**
 * Close (×): the user is finished with this thread — the `exit_clean` of the
 * UI, and the host's one way to put the thread away. Closes the conversation
 * and drops its task (the conversation view's Drop & Close, `dropAndExit`: a
 * scratch thread has no work to land, so its task always drops), then hands
 * back to the host through `onEnded`.
 *
 * Always there, so a thread is never left without a way out: pending until
 * the conversation's row has arrived, and once it is closed (`done`), gone or
 * deleted a click only hands back. A failure is a toast; the thread stays as
 * it was. Closing stops the agent, which needs the computer: on a host
 * without it (the demo) the button is disabled and its tooltip says why.
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
  if (row.status === "error") throw row.error;
  const ended =
    row.status === "ready" &&
    (row.data === null ||
      row.data.status === "done" ||
      row.data.status === "gone");
  if (ended) {
    return (
      <IconButton icon={closeIcon} label="Close" onClick={() => onEnded?.()} />
    );
  }
  if (close.kind === "unavailable") {
    return (
      <IconButton
        icon={closeIcon}
        label="Close"
        tooltip={close.message}
        disabled
      />
    );
  }
  return (
    <IconButton
      icon={closeIcon}
      label="Close"
      tooltip="Close — ends the conversation and drops its task"
      loading={row.status !== "ready" || close.isPending}
      onClick={() => close.mutate({ params: { id: conversationId } })}
    />
  );
}
