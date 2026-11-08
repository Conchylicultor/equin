import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { OutsideFiles } from "./module-graph";

/**
 * The files outside a snapshot (gitignored), read from the checkout at `root`
 * when the module graph asks for one: its content, or null when no file is
 * there. Asynchronous, so a graph grown on a backend (the faceted tree a
 * review builds) holds no thread on the disk. A fresh reader per call: two
 * graphs over one snapshot share a walk only when they share the reader.
 */
export function outsideFilesAt(root: AppPath): OutsideFiles {
  return async (rel) => {
    try {
      return await readFile(joinAppPath(root, rel), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
        return null;
      }
      throw err;
    }
  };
}
