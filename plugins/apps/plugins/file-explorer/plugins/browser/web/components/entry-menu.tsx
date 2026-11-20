import type { ReactNode } from "react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CursorAnchoredMenu,
  type CursorAnchor,
} from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { RemoveMode } from "../internal/entry-edits";

const renameIcon = symbol("drive-file-rename-outline");
const newFileIcon = symbol("note-add");
const newFolderIcon = symbol("create-new-folder");
const trashIcon = symbol("delete");
const deleteIcon = symbol("delete-forever");

/**
 * What a right-click landed on: an entry (with the entries the menu's removal
 * acts on — the selection it belongs to, else itself), or the empty space of
 * the folder.
 */
export type EntryMenuTarget =
  | { kind: "entry"; path: string; paths: readonly string[] }
  | { kind: "folder"; dir: string };

export interface EntryMenuState {
  anchor: CursorAnchor;
  target: EntryMenuTarget;
  /** The folder the entry sits in (or the folder clicked) takes new entries. */
  writable: boolean;
}

/**
 * The browser's context menu, at the click: Rename an entry, New text file /
 * New folder beside it (or in the folder clicked), then Move to Trash — where
 * the system has one — and Delete. An action the place cannot take (inside an
 * archive) is shown disabled, so the menu reads the same everywhere.
 */
export function EntryMenu({
  menu,
  onClose,
  canTrash,
  onRename,
  onNew,
  onRemove,
}: {
  menu: EntryMenuState | null;
  onClose: () => void;
  canTrash: boolean;
  onRename: (path: string) => void;
  onNew: (kind: "file" | "dir") => void;
  onRemove: (mode: RemoveMode) => void;
}): ReactNode {
  const target = menu?.target ?? null;
  const writable = menu?.writable ?? false;
  const entry = target?.kind === "entry" ? target : null;
  const many = entry !== null && entry.paths.length > 1;
  return (
    <CursorAnchoredMenu anchor={menu?.anchor ?? null} onClose={onClose}>
      {entry !== null && (
        <>
          <DropdownMenuItem
            disabled={!writable || many}
            onClick={() => onRename(entry.path)}
          >
            <Icon icon={renameIcon} />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem disabled={!writable} onClick={() => onNew("file")}>
        <Icon icon={newFileIcon} />
        New text file
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!writable} onClick={() => onNew("dir")}>
        <Icon icon={newFolderIcon} />
        New folder
      </DropdownMenuItem>
      {entry !== null && (
        <>
          <DropdownMenuSeparator />
          {canTrash && (
            <DropdownMenuItem
              disabled={!writable}
              onClick={() => onRemove("trash")}
            >
              <Icon icon={trashIcon} />
              {many
                ? `Move ${entry.paths.length} items to Trash`
                : "Move to Trash"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            disabled={!writable}
            onClick={() => onRemove("delete")}
          >
            <Icon icon={deleteIcon} />
            {many ? `Delete ${entry.paths.length} items…` : "Delete…"}
          </DropdownMenuItem>
        </>
      )}
    </CursorAnchoredMenu>
  );
}
