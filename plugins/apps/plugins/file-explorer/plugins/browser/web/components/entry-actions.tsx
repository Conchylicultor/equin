import type { ReactNode } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useOpenHostFile } from "@plugins/primitives/plugins/file-viewer/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import type { EntryRow } from "../../core";
import {
  useActionTargets,
  useEntryActionHost,
} from "../internal/entry-action-host";

// The browser's own row actions. Each is ONE component drawn two ways — an
// icon button in the row's hover cluster (or its `⋯`), a menu item in the
// right-click menu (`MenuItemForm`) — and acts on `useActionTargets(row)`:
// the row, or the selection a right-click was opened on. An action the
// targets cannot take renders nothing, so neither place offers it.

const revealIcon = symbol("folder-open");
const renameIcon = symbol("drive-file-rename-outline");
const copyIcon = symbol("content-copy");
const cutIcon = symbol("content-cut");
const compressIcon = symbol("folder-zip");
const trashIcon = symbol("delete");
const deleteIcon = symbol("delete-forever");

/** `one` for a single entry, else `many` with the count. */
function counted(paths: readonly string[], one: string, many: string): string {
  return paths.length === 1
    ? one
    : `${many.replace("#", String(paths.length))}`;
}

/** Open with default app — a file of the computer's disk (not inside an archive). */
export function OpenAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  const openHostFile = useOpenHostFile();
  if (
    targets.length !== 1 ||
    row.kind === "dir" ||
    !host.system.capabilities.openNative ||
    !host.onDisk(row.path)
  ) {
    return null;
  }
  return (
    <IconButton
      icon={navIcons.hostApp}
      label="Open with default app"
      onClick={() => void openHostFile(host.abs(row.path))}
    />
  );
}

/** Reveal in Finder — the entry selected in a Finder window. */
export function RevealAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  const openHostFile = useOpenHostFile();
  if (targets.length !== 1 || !host.system.capabilities.openNative) return null;
  return (
    <IconButton
      icon={revealIcon}
      label="Reveal in Finder"
      onClick={() => void openHostFile(host.abs(row.path), { reveal: true })}
    />
  );
}

/** Rename — the row's name opens for editing in place. */
export function RenameAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  if (
    targets.length !== 1 ||
    !host.system.capabilities.edit ||
    !host.onDisk(row.path)
  ) {
    return null;
  }
  return (
    <IconButton
      icon={renameIcon}
      label="Rename"
      onClick={() => host.startRename(row.path)}
    />
  );
}

/** Copy — the entries on the clipboard, to paste as copies (⌘V). */
export function CopyAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  if (!host.system.capabilities.copy || !targets.every(host.onDisk)) {
    return null;
  }
  return (
    <IconButton
      icon={copyIcon}
      label={counted(targets, "Copy", "Copy # items")}
      shortcut="mod+c"
      onClick={() => host.toClipboard(targets, "copy")}
    />
  );
}

/** Cut — the entries on the clipboard, to move where they are pasted (⌘V). */
export function CutAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  if (!host.system.capabilities.move || !targets.every(host.onDisk)) {
    return null;
  }
  return (
    <IconButton
      icon={cutIcon}
      label={counted(targets, "Cut", "Cut # items")}
      shortcut="mod+x"
      onClick={() => host.toClipboard(targets, "cut")}
    />
  );
}

/** Compress — a .zip of the entries beside them. */
export function CompressAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  if (!host.system.capabilities.compress || !targets.every(host.onDisk)) {
    return null;
  }
  return (
    <IconButton
      icon={compressIcon}
      label={counted(targets, `Compress “${row.name}”`, "Compress # items")}
      onClick={() => host.compress(targets)}
    />
  );
}

/** Move to Trash — where the system has one, to be put back from it. */
export function TrashAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  if (!host.system.capabilities.trash || !targets.every(host.onDisk)) {
    return null;
  }
  return (
    <IconButton
      icon={trashIcon}
      label={counted(targets, "Move to Trash", "Move # items to Trash")}
      onClick={() => host.remove(targets, "trash")}
    />
  );
}

/** Delete… — for good, asked first. */
export function DeleteAction({ row }: ItemActionProps<EntryRow>): ReactNode {
  const host = useEntryActionHost();
  const targets = useActionTargets(row);
  if (!host.system.capabilities.edit || !targets.every(host.onDisk)) {
    return null;
  }
  return (
    <IconButton
      icon={deleteIcon}
      label={counted(targets, "Delete…", "Delete # items…")}
      variant="destructive"
      onClick={() => host.remove(targets, "delete")}
    />
  );
}
