import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { restorePrototype } from "@plugins/apps/plugins/prototypes/plugins/state/core";
import type { PrototypeGalleryRow } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const restoreIcon = symbol("restore-from-trash");

// The gallery's Trash view: a deleted prototype is a prototype whose state row
// carries `deletedAt` (`state`'s `DELETE /api/prototypes/:name`) — its folder,
// history and picks untouched — so restoring it is clearing that one field.

/**
 * Restore prototype `name` from the Trash. A failed write surfaces through the
 * endpoint layer's global error toast.
 */
export function useRestorePrototype(): {
  pending: boolean;
  restore: (name: string) => void;
} {
  const mutation = useEndpointMutation(restorePrototype);
  return {
    pending: mutation.isPending,
    restore: (name) => mutation.mutate({ params: { name } }),
  };
}

/** A Trash card's Restore: back into the gallery, as it was. */
export function RestoreCardAction({
  row,
}: ItemActionProps<PrototypeGalleryRow>) {
  const { pending, restore } = useRestorePrototype();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={restoreIcon}
        label="Restore prototype"
        variant="ghost"
        loading={pending}
        onClick={(e) => {
          // The card's own click opens the prototype; restoring it must not.
          e.stopPropagation();
          restore(row.name);
        }}
      />
    </ControlSizeProvider>
  );
}
