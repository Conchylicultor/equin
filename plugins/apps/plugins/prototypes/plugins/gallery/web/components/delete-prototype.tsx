import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import {
  deletePrototype,
  prototypesList,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  prototypeDetailPane,
  TitleActionButton,
  usePrototypeDetail,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { PrototypeGalleryRow } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const deleteIcon = symbol("delete");

// Deleting a prototype (`files`' `DELETE /api/prototypes/:name`): its folder
// moves into the data dir's `_trash/`, so the gallery loses it while the work
// itself is kept. Always confirmed — the folder is the only copy of the design,
// and it is shared by every worktree and main. The list re-broadcasts when the
// folder leaves the watched tree, so nothing here removes the card by hand.

/**
 * Open the confirm dialog for prototype `name`; `onDeleted` runs once the
 * folder has actually moved (never on Cancel, never on a failure — the dialog
 * stays open with the reason then).
 */
function useConfirmDeletePrototype(): (
  name: string,
  title: string,
  onDeleted?: () => void,
) => void {
  const mutation = useEndpointMutation(deletePrototype);
  return (name, title, onDeleted) => {
    void confirmDialog({
      title: `Delete “${title}”?`,
      description: (
        <>
          It leaves the gallery for every worktree and main. The folder is kept
          in the prototypes data dir&apos;s <code>_trash/</code>, with its
          version history, so it can be moved back by hand.
        </>
      ),
      confirmLabel: "Delete",
      onConfirm: async () => {
        await mutation.mutateAsync({ params: { name } });
        onDeleted?.();
      },
    });
  };
}

/** The card's Delete: a hover action, last in the cluster. */
export function DeleteCardAction({
  row,
}: ItemActionProps<PrototypeGalleryRow>) {
  const confirmDelete = useConfirmDeletePrototype();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={deleteIcon}
        label="Delete prototype"
        variant="ghost"
        onClick={(e) => {
          // The card's own click opens the prototype; deleting it must not.
          e.stopPropagation();
          confirmDelete(row.name, row.title);
        }}
      />
    </ControlSizeProvider>
  );
}

/**
 * The detail pane header's Delete, after the pin and the Done toggle. Once the
 * prototype is gone the pane goes back to the gallery, rather than staying on
 * a "Prototype not found" page. Disabled until the list is known, since the
 * dialog names the prototype by its title; a failed read is the error icon,
 * whose click retries.
 */
export function DeleteHeaderAction() {
  const { name } = usePrototypeDetail();
  const list = useLive(prototypesList);
  const back = prototypeDetailPane.useBack();
  const confirmDelete = useConfirmDeletePrototype();
  const disabled = (
    <TitleActionButton icon={deleteIcon} label="Delete" disabled />
  );
  return matchResource(list, {
    loading: () => disabled,
    error: (error) => (
      <ResourceErrorInline
        variant="icon"
        icon={deleteIcon}
        subject="the prototype list"
        error={error}
        refetch={list.refetch}
      />
    ),
    ready: (rows) => {
      const meta = rows.find((p) => p.name === name);
      // No such prototype: the pane body says so; there is nothing to delete.
      if (meta === undefined) return disabled;
      return (
        <TitleActionButton
          icon={deleteIcon}
          label="Delete prototype"
          onClick={() =>
            confirmDelete(meta.name, meta.title, back ?? undefined)
          }
        />
      );
    },
  });
}
