import type { ReactElement } from "react";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { RenameConversationDialog } from "./rename-dialog";

const renameIcon = symbol("drive-file-rename");

/** What the action reads of a row: any conversation list's row has both. */
export type RenamableConversation = { id: string; title: string | null };

/**
 * Rename the row's conversation: opens a dialog seeded with its current
 * title. Generic over the row so every conversation list contributes the same
 * action into its own item-actions slot.
 */
export function RenameConversationAction({
  row,
}: ItemActionProps<RenamableConversation>): ReactElement {
  const openDialog = useOpenDialog();
  return (
    <IconButton
      icon={renameIcon}
      label="Rename conversation"
      onClick={(e) => {
        e.stopPropagation();
        void openDialog(
          (close) => (
            <RenameConversationDialog
              id={row.id}
              title={row.title ?? ""}
              onClose={close}
            />
          ),
          { size: "sm" },
        );
      }}
    />
  );
}
