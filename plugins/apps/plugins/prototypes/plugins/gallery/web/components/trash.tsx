import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { restorePrototype } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { PrototypeGalleryRow } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const deleteIcon = symbol("delete");
const restoreIcon = symbol("restore-from-trash");

// The gallery's Trash: a deleted prototype is a prototype whose status carries
// `deletedAt` (`files`' `DELETE /api/prototypes/:name`) — its folder, history
// and picks untouched — so restoring it is clearing that one field.

/**
 * The gallery header's way into the Trash, beside New prototype. The count of
 * deleted prototypes follows it once known, and is omitted at zero — and while
 * not yet known, never a "0" standing in for it.
 */
export function TrashButton({
  count,
  onOpen,
}: {
  count: number | undefined;
  onOpen: () => void;
}) {
  return (
    <Button variant="ghost" onClick={onOpen}>
      <Icon icon={deleteIcon} />
      Trash
      {count === undefined || count === 0 ? null : (
        <span className="text-muted-foreground">{count}</span>
      )}
    </Button>
  );
}

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
