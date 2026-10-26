import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
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
  /**
   * `label` — the ghost "Done" button, shown only while there is something
   * to end; `icon` — a × ("Close"), the host's ONE way to put the thread
   * away: always there, ending the conversation when it is still open and
   * just handing back (`onEnded`) when it already ended.
   */
  display?: "label" | "icon";
}

/**
 * Done: the user is finished with this thread — the `exit_clean` of the UI.
 * Closes the conversation and drops its task (the conversation view's
 * Drop & Close, `dropAndExit`: a scratch thread has no work to land, so its
 * task always drops), then hands back to the host through `onEnded`.
 *
 * As a label, renders nothing until the conversation's row has arrived, and
 * nothing once it is closed (`done`) or gone — there is nothing left to end.
 * As an icon, it is pending until the row arrives, and once the conversation
 * is closed, gone or deleted a click only hands back. A failure is a toast;
 * the thread stays as it was. Closing stops the agent, which needs the
 * computer: on a host without it (the demo) the button is disabled and its
 * tooltip says why.
 */
export function EndThreadButton({
  conversationId,
  onEnded,
  display = "label",
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
  const ended =
    row.status === "ready" &&
    (row.data === null ||
      row.data.status === "done" ||
      row.data.status === "gone");
  if (display === "icon") {
    if (row.status === "error") throw row.error;
    if (ended) {
      return (
        <IconButton
          icon={closeIcon}
          label="Close"
          onClick={() => onEnded?.()}
        />
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
  if (row.status !== "ready" || ended) return null;
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
