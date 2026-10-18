import { createContext, useContext, type ReactElement } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  restoreTrash,
  type TrashEntryRow,
} from "@plugins/infra/plugins/trash/core";
import { PAGES_TRASH_SOURCE } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const restoreFromTrashIcon = symbol("restore-from-trash");
const deleteForeverIcon = symbol("delete-forever");

/** Row actions of the pages trash list. */
export const TrashItemActions = defineItemActions<TrashEntryRow>();

/**
 * Who handles a permanent delete: the open Trash dialog, which asks for
 * confirmation first (the purge fires the FK cascades — irreversible). An
 * action component receives only its row, so the dialog provides the handler
 * around its list.
 */
export const PurgeTrashEntryContext = createContext<
  ((entry: TrashEntryRow) => void) | null
>(null);

/**
 * Restore — no confirmation: it is the undo. The row leaves the list through
 * the live collection once the entry is consumed.
 */
export function RestoreTrashEntryAction({
  row,
}: ItemActionProps<TrashEntryRow>): ReactElement {
  const restore = useEndpointMutation(restoreTrash);
  return (
    <IconButton
      icon={restoreFromTrashIcon}
      label="Restore"
      loading={restore.isPending}
      onClick={(e) => {
        e.stopPropagation();
        restore.mutate({
          params: { sourceId: PAGES_TRASH_SOURCE, entryId: row.id },
        });
      }}
    />
  );
}

/** Delete permanently — opens the dialog's confirmation for this entry. */
export function PurgeTrashEntryAction({
  row,
}: ItemActionProps<TrashEntryRow>): ReactElement {
  const onPurge = useContext(PurgeTrashEntryContext);
  if (onPurge === null) {
    throw new Error(
      "PurgeTrashEntryAction rendered outside the pages Trash dialog's list",
    );
  }
  return (
    <IconButton
      icon={deleteForeverIcon}
      label="Delete permanently"
      onClick={(e) => {
        e.stopPropagation();
        onPurge(row);
      }}
    />
  );
}
