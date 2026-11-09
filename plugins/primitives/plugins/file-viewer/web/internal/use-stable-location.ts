import { useMemo } from "react";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

/**
 * The same `FileLocation` object for as long as it names the same file. Hosts
 * build the location inline (`{ fs: "checkout", checkout, path }`), a fresh
 * object every render, so anything keyed on it would re-resolve each render.
 */
export function useStableLocation(file: FileLocation): FileLocation {
  const { fs, path } = file;
  const checkout = file.fs === "checkout" ? file.checkout : "";
  const version = file.fs === "checkout" ? file.version : undefined;
  return useMemo<FileLocation>(
    () =>
      fs === "checkout"
        ? {
            fs,
            checkout,
            path,
            ...(version !== undefined ? { version } : {}),
          }
        : { fs, path },
    [fs, path, checkout, version],
  );
}
