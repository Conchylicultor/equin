import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { pageData, type Block } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useTrashPage } from "../internal/use-trash-page";

const deleteIcon = symbol("delete");

/** Move a page to the trash from its sidebar row (see `useTrashPage`). */
export function DeletePageAction({ row }: ItemActionProps<Block>) {
  const trashPage = useTrashPage();
  // `IconButton` (as the sibling star row-action already does): it auto-pends
  // while the returned promise is in flight, so the delete cannot be
  // double-fired, and it derives its size from the row's ambient control density.
  return (
    <IconButton
      icon={deleteIcon}
      label="Delete page"
      onClick={(e) => {
        e.stopPropagation();
        return trashPage({ id: row.id, title: pageData(row).title });
      }}
    />
  );
}
