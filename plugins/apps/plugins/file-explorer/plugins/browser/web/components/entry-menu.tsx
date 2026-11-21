import { Fragment, type ReactNode } from "react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CursorAnchoredMenu,
  type CursorAnchor,
} from "@plugins/primitives/plugins/overlay/plugins/cursor-menu/web";
import { MenuItemForm } from "@plugins/primitives/plugins/action-presentation/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import {
  isNodeData,
  useReorderedEntries,
  type TopLevelEntry,
} from "@plugins/reorder/web";
import { useReorderNodeTypes } from "@plugins/reorder/plugins/node-types/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { EntryRow } from "../../core";
import { FileBrowserSlots } from "../slots";
import { MenuTargets } from "../internal/entry-action-host";

const newFileIcon = symbol("note-add");
const newFolderIcon = symbol("create-new-folder");
const pasteIcon = symbol("content-paste");

/**
 * What a right-click landed on: an entry (its row, and the entries the menu
 * acts on — the selection it belongs to, else itself), or the empty space of
 * the folder.
 */
export type EntryMenuTarget =
  | { kind: "entry"; row: EntryRow; paths: readonly string[] }
  | { kind: "folder"; dir: string };

export interface EntryMenuState {
  anchor: CursorAnchor;
  target: EntryMenuTarget;
  /** The folder new entries and a paste go into — the folder clicked, or the one holding the entry. */
  folder: string;
  /** Whether that folder takes new entries (one of the system's own, not inside an archive). */
  writable: boolean;
}

/**
 * The browser's context menu, at the click. On an entry: every row action —
 * the very list its hover cluster draws (`FileBrowserSlots.RowActions`, in
 * its layout order), each as a menu item (`MenuItemForm`) acting on the
 * entries the menu was opened on. Then, for the folder: New text file, New
 * folder and Paste (with something on the clipboard to paste here).
 */
export function EntryMenu({
  menu,
  onClose,
  canCreate,
  canPaste,
  onNew,
  onPaste,
}: {
  menu: EntryMenuState | null;
  onClose: () => void;
  canCreate: boolean;
  /** How many entries a paste would put here; `0` when there is nothing to paste. */
  canPaste: number;
  onNew: (kind: "file" | "dir") => void;
  onPaste: () => void;
}): ReactNode {
  const target = menu?.target ?? null;
  const writable = menu?.writable ?? false;
  return (
    <CursorAnchoredMenu anchor={menu?.anchor ?? null} onClose={onClose}>
      {target?.kind === "entry" && (
        <MenuTargets paths={target.paths}>
          <RowActionItems row={target.row} />
        </MenuTargets>
      )}
      {canCreate && (
        <>
          {target?.kind === "entry" && <DropdownMenuSeparator />}
          <DropdownMenuItem disabled={!writable} onClick={() => onNew("file")}>
            <Icon icon={newFileIcon} />
            New text file
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!writable} onClick={() => onNew("dir")}>
            <Icon icon={newFolderIcon} />
            New folder
          </DropdownMenuItem>
        </>
      )}
      {target?.kind === "folder" && (
        <>
          {canCreate && <DropdownMenuSeparator />}
          <DropdownMenuItem
            disabled={!writable || canPaste === 0}
            shortcut={formatShortcutLabel("mod+v")}
            onClick={onPaste}
          >
            <Icon icon={pasteIcon} />
            {canPaste > 1 ? `Paste ${canPaste} items` : "Paste"}
          </DropdownMenuItem>
        </>
      )}
    </CursorAnchoredMenu>
  );
}

/**
 * Every row action of `row`, in the hover cluster's layout order and grouped
 * by its dividers, as menu items. A divider is drawn by its own node type —
 * the very rule the `⋯` panel draws — which hides itself when the group it
 * closes renders nothing (single-entry actions on a selection), so a rule
 * never doubles up or closes off an end.
 */
function RowActionItems({ row }: { row: EntryRow }): ReactNode {
  const slot = FileBrowserSlots.RowActions;
  const order = useReorderedEntries(
    slot.id,
    slot.useContributions() as unknown as readonly Contribution[],
  );
  const nodeTypes = useReorderNodeTypes();
  const state =
    order.status === "ready"
      ? order.data
      : order.status === "error"
        ? (order.stale ?? null)
        : null;
  if (state === null) {
    if (order.status === "error") {
      throw new Error(
        "file-explorer: the row actions' layout could not be read",
        { cause: order.error },
      );
    }
    return null;
  }
  const props: ItemActionProps<EntryRow> = {
    row,
    hasChildren: false,
    placement: "cluster",
  };
  // An overflow group's members stand in its place: a menu has no `⋯`.
  const flat = (entries: readonly TopLevelEntry[]): TopLevelEntry[] =>
    entries.flatMap((e) =>
      isNodeData(e) && e.members !== undefined ? flat(e.members) : [e],
    );
  return flat(state.entries).map((entry) => {
    if (!isNodeData(entry)) {
      return (
        <MenuItemForm key={`${entry._pluginId ?? ""}:${String(entry.id)}`}>
          {renderIsolated(slot, entry, props)}
        </MenuItemForm>
      );
    }
    const nodeType = nodeTypes.get(entry.type);
    if (nodeType === undefined) {
      throw new Error(
        `file-explorer: the row actions' layout names an unknown node type "${entry.type}"`,
      );
    }
    return (
      <Fragment key={entry.id ?? entry.type}>
        {nodeType.render({
          payload: entry.payload,
          id: entry.id,
          editMode: false,
          orientation: "vertical",
          onPatch: () => {
            throw new Error(
              "file-explorer: a menu's layout node is never edited",
            );
          },
          onRemove: () => {
            throw new Error("file-explorer: a menu's divider is never removed");
          },
        })}
      </Fragment>
    );
  });
}
