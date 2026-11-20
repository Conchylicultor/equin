import { useSyncExternalStore } from "react";
import type { BrowsableFileSystem } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

/**
 * Entries copied or cut in a browser, waiting to be pasted into a folder:
 * one system's absolute paths. Copy pastes copies; cut moves them (and is
 * spent by the paste).
 */
export interface FileClipboard {
  fs: BrowsableFileSystem;
  paths: readonly string[];
  mode: "copy" | "cut";
}

// The page's one file clipboard — what every browser on the page (Files, a
// conversation's Files pane, a folder peek) pastes from, as the Finder's is
// the whole desktop's. In memory only: a reload starts with nothing to paste,
// as the Finder after a restart. Page-global on purpose, never per surface:
// a copy in one window or pane is pasted in another.
let current: FileClipboard | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Put entries on the clipboard (`null` empties it). */
export function setFileClipboard(next: FileClipboard | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** What is on the clipboard now, re-rendering when it changes. */
export function useFileClipboard(): FileClipboard | null {
  const snapshot = () => current;
  // A static render has copied nothing: the same (empty) snapshot.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
