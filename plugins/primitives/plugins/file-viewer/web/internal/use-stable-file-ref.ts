import { useMemo } from "react";
import type { FileRef } from "../../core";

/**
 * The same `FileRef` object for as long as it names the same file. Hosts build
 * the ref inline (`{ source: "workspace", workspace, path }`), a fresh object every
 * render; anything memoized on it would recompute every render too.
 */
export function useStableFileRef(file: FileRef): FileRef {
  const { source, path } = file;
  const workspace = file.source === "workspace" ? file.workspace : "";
  const ref = file.source === "workspace" ? file.ref : undefined;
  return useMemo<FileRef>(
    () =>
      source === "host"
        ? { source, path }
        : { source, workspace, path, ...(ref !== undefined ? { ref } : {}) },
    [source, path, workspace, ref],
  );
}
