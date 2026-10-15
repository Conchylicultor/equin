import { createContext, useContext } from "react";

/**
 * The absolute folder a browser region shows, for whatever renders inside it —
 * a client-fields resolver of the `fileEntry` kind has only its rows, which do not say
 * which folder (or checkout) they were listed from.
 */
export const ExplorerDirContext = createContext<string | null>(null);

/** `useExplorerDir()` was called outside a `<FileBrowser/>`. */
export class ExplorerDirMissingError extends Error {
  constructor() {
    super("useExplorerDir() is only available inside a <FileBrowser/>");
    this.name = "ExplorerDirMissingError";
  }
}

/** The absolute folder the surrounding browser shows. Throws outside a browser. */
export function useExplorerDir(): string {
  const dir = useContext(ExplorerDirContext);
  if (dir === null) {
    throw new ExplorerDirMissingError();
  }
  return dir;
}
