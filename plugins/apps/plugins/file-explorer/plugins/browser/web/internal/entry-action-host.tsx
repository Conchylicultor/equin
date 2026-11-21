import { createContext, useContext, type ReactNode } from "react";
import type { EntryRow } from "../../core";
import type { RemoveMode } from "./entry-edits";
import type { ExplorerSystem } from "./explorer-system";

/**
 * What a listing does for the row actions it draws — in a row's hover
 * cluster and in its right-click menu alike, so one action is one component
 * whichever way it is drawn. Paths are in the listing's display form.
 */
export interface EntryActionHost {
  system: ExplorerSystem;
  /** `path` absolute, as a system endpoint takes it. */
  abs: (path: string) => string;
  /**
   * Whether `path` is one of the system's own entries — its folder is not
   * inside an archive — so it can be renamed, moved, copied or removed.
   */
  onDisk: (path: string) => boolean;
  /** The folder holding `path`. */
  folderOf: (path: string) => string;
  startRename: (path: string) => void;
  remove: (paths: readonly string[], mode: RemoveMode) => void;
  /** Put `paths` on the page's file clipboard, to paste as copies or a move. */
  toClipboard: (paths: readonly string[], mode: "copy" | "cut") => void;
  /** How many entries a paste would put down; `0` with nothing on the clipboard to paste here. */
  pasteCount: number;
  /** Whether `folder` takes new entries — one of the system's own folders. */
  takesEntries: (folder: string) => boolean;
  /** Paste the clipboard's entries into `folder` — as copies, or moved for a cut. */
  paste: (folder: string) => void;
  compress: (paths: readonly string[]) => void;
}

const EntryActionHostContext = createContext<EntryActionHost | null>(null);

export function EntryActionHostProvider({
  value,
  children,
}: {
  value: EntryActionHost;
  children: ReactNode;
}): ReactNode {
  return (
    <EntryActionHostContext.Provider value={value}>
      {children}
    </EntryActionHostContext.Provider>
  );
}

/** The listing drawing this action. Only a browser's listing draws its row actions. */
export function useEntryActionHost(): EntryActionHost {
  const host = useContext(EntryActionHostContext);
  if (host === null) {
    throw new Error(
      "file-explorer: a row action rendered outside a browser's listing (EntryActionHostProvider)",
    );
  }
  return host;
}

/**
 * The entries a right-click menu acts on — the selection it was opened on, or
 * the one entry — around the row actions it draws as menu items.
 */
const MenuTargetsContext = createContext<readonly string[] | null>(null);

export function MenuTargets({
  paths,
  children,
}: {
  paths: readonly string[];
  children: ReactNode;
}): ReactNode {
  return (
    <MenuTargetsContext.Provider value={paths}>
      {children}
    </MenuTargetsContext.Provider>
  );
}

/**
 * The paths an action on `row` acts on: the menu's targets when it was opened
 * on a selection holding the row (the Finder's rule), else the row alone (a
 * hover cluster acts on its own row).
 */
export function useActionTargets(row: EntryRow): readonly string[] {
  const targets = useContext(MenuTargetsContext);
  return targets !== null && targets.includes(row.path) ? targets : [row.path];
}
