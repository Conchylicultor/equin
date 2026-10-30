import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { Server } from "../../shared";
import { deleteServer } from "../../shared/endpoints";
import { DeleteServerDialog } from "./delete-server-dialog";

/**
 * The Danger zone section's body: the destructive verb on a server, apart from
 * the Connection fields it used to ride the header of.
 */
export function ServerDeleteAction({ server }: { server: Server }) {
  const remove = useEndpointMutation(deleteServer);

  function handleDelete() {
    // Fire-and-forget: don't return the openDialog promise, or the button would
    // auto-pend for the dialog's whole open lifetime. The dialog's Delete pends
    // on the write and closes once the server has removed it.
    void openDialog(
      (close) => (
        <DeleteServerDialog
          server={server}
          onCancel={close}
          onConfirm={async () => {
            await remove.mutateAsync({ params: { id: server.id } });
            close();
          }}
        />
      ),
      { size: "sm" },
    );
  }

  return (
    <Stack gap="sm" align="start">
      <Text as="p" variant="caption" tone="muted">
        Removes the server from this app. Its sites must be removed first.
      </Text>
      <Button variant="destructive" onClick={handleDelete}>
        Delete {server.name}
      </Button>
    </Stack>
  );
}
