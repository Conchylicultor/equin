import { createContext, useContext } from "react";
import type { ExplorerFolder } from "../../core";

/**
 * The folder a browser region shows (its file system, and the absolute path
 * in it), for whatever renders inside it — a client-fields resolver of the
 * `fileEntry` kind has only its rows, which do not say which folder (or
 * checkout) they were listed from.
 */
export const ExplorerDirContext = createContext<ExplorerFolder | null>(null);

/** `useExplorerDir()` was called outside a `<FileBrowser/>`. */
export class ExplorerDirMissingError extends Error {
  constructor() {
    super("useExplorerDir() is only available inside a <FileBrowser/>");
    this.name = "ExplorerDirMissingError";
  }
}

/** The folder the surrounding browser shows. Throws outside a browser. */
export function useExplorerDir(): ExplorerFolder {
  const dir = useContext(ExplorerDirContext);
  if (dir === null) {
    throw new ExplorerDirMissingError();
  }
  return dir;
}
