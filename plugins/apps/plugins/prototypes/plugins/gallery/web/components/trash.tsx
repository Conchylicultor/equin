import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { restorePrototype } from "@plugins/apps/plugins/prototypes/plugins/state/core";
import type { PrototypeGalleryRow } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const restoreIcon = symbol("restore-from-trash");

// The gallery's Trash view: a deleted prototype is a prototype whose state row
// carries `deletedAt` (`state`'s `DELETE /api/prototypes/:name`) — its folder,
// history and picks untouched — so restoring it is clearing that one field.

/**
 * Restore prototype `name` from the Trash. A refused write is the rejection
 * toast.
 */
export function useRestorePrototype(): {
  restore: (name: string) => void;
} {
  // Predicted: the card leaves the Trash at once, so there is no pending state.
  const mutation = useLiveMutation(restorePrototype);
  return {
    restore: (name) => mutation.mutate({ params: { name } }),
  };
}

/** A Trash card's Restore: back into the gallery, as it was. */
export function RestoreCardAction({
  row,
}: ItemActionProps<PrototypeGalleryRow>) {
  const { restore } = useRestorePrototype();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={restoreIcon}
        label="Restore prototype"
        variant="ghost"
        onClick={(e) => {
          // The card's own click opens the prototype; restoring it must not.
          e.stopPropagation();
          restore(row.name);
        }}
      />
    </ControlSizeProvider>
  );
}
