import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import type { Server } from "../../shared";
import { deleteServer } from "../../shared/endpoints";
import { DeleteServerDialog } from "./delete-server-dialog";

/**
 * Delete, as the identity section's header `action` rather than a row inside its
 * body — the destructive verb on a server stays reachable with the card shut,
 * and the body is only the fields.
 */
export function ServerDeleteAction({ server }: { server: Server }) {
  const remove = useLiveMutation(deleteServer);

  function handleDelete() {
    // Fire-and-forget: don't return the openDialog promise, or the button would
    // auto-pend for the dialog's whole open lifetime. The delete is predicted:
    // the server leaves every read and the dialog closes at once.
    void openDialog(
      (close) => (
        <DeleteServerDialog
          server={server}
          onCancel={close}
          onConfirm={() => {
            remove.mutate({ params: { id: server.id } });
            close();
          }}
        />
      ),
      { size: "sm" },
    );
  }

  return (
    <Button
      variant="link"
      onClick={handleDelete}
      className="text-destructive hover:text-destructive"
    >
      Delete
    </Button>
  );
}
