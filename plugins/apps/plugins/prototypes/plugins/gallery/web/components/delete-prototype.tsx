import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  useCombinedResources,
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  deletePrototype,
  prototypeStatuses,
  prototypesList,
  statusOf,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  prototypeDetailPane,
  TitleActionButton,
  usePrototypeDetail,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { PrototypeGalleryRow } from "../slots";
import { useRestorePrototype } from "./trash";
import { symbol } from "@plugins/ui/plugins/icons/core";

const deleteIcon = symbol("delete");
const restoreIcon = symbol("restore-from-trash");

// Deleting a prototype (`files`' `DELETE /api/prototypes/:name`) records
// `deletedAt` in its status: nothing on disk moves, the gallery stops listing
// it and its Trash starts to. So a delete is as reversible as a Done tick —
// no confirm dialog, but a toast whose Undo restores it at once. The statuses
// re-broadcast on the write, so nothing here removes the card by hand.

/**
 * Delete prototype `name`; once the server has recorded it, a toast says so
 * with Undo, and `onDeleted` runs (never on a failure — that is the endpoint
 * layer's error toast).
 */
function useDeletePrototype(): (
  name: string,
  title: string,
  onDeleted?: () => void,
) => void {
  const mutation = useEndpointMutation(deletePrototype);
  const { restore } = useRestorePrototype();
  return (name, title, onDeleted) => {
    mutation.mutate(
      { params: { name } },
      {
        onSuccess: () => {
          showToast({
            description: `Deleted “${title}” — it is in the gallery's Trash.`,
            action: { label: "Undo", onClick: () => restore(name) },
          });
          onDeleted?.();
        },
      },
    );
  };
}

/** The card's Delete: a hover action, last in the cluster. */
export function DeleteCardAction({
  row,
}: ItemActionProps<PrototypeGalleryRow>) {
  const deleteNow = useDeletePrototype();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={deleteIcon}
        label="Delete prototype"
        variant="ghost"
        onClick={(e) => {
          // The card's own click opens the prototype; deleting it must not.
          e.stopPropagation();
          deleteNow(row.name, row.title);
        }}
      />
    </ControlSizeProvider>
  );
}

/**
 * The detail pane header's Delete, after the pin and the Done toggle. Once
 * deleted the pane goes back to the gallery it came from (the toast's Undo
 * still restores it). On a prototype already deleted — opened from the Trash,
 * or a link — it is Restore instead. Disabled until the list and the statuses
 * are known, since the toast names the prototype by its title and the button
 * must know which of the two it is; a failed read is the error icon, whose
 * click retries.
 */
export function DeleteHeaderAction() {
  const { name } = usePrototypeDetail();
  const result = useCombinedResources({
    list: useLive(prototypesList),
    statuses: useLive(prototypeStatuses),
  });
  const back = prototypeDetailPane.useBack();
  const deleteNow = useDeletePrototype();
  const { pending, restore } = useRestorePrototype();
  const disabled = (
    <TitleActionButton icon={deleteIcon} label="Delete" disabled />
  );
  return matchResource(result, {
    loading: () => disabled,
    error: (error) => (
      <ResourceErrorInline
        variant="icon"
        icon={deleteIcon}
        subject="the prototype"
        error={error}
        refetch={result.refetch}
      />
    ),
    ready: ({ list, statuses }) => {
      const meta = list.find((p) => p.name === name);
      // No such prototype: the pane body says so; there is nothing to delete.
      if (meta === undefined) return disabled;
      if (statusOf(statuses, name).deletedAt !== null) {
        return (
          <TitleActionButton
            icon={restoreIcon}
            label="Restore prototype"
            loading={pending}
            onClick={() => restore(name)}
          />
        );
      }
      return (
        <TitleActionButton
          icon={deleteIcon}
          label="Delete prototype"
          onClick={() => deleteNow(meta.name, meta.title, back ?? undefined)}
        />
      );
    },
  });
}
