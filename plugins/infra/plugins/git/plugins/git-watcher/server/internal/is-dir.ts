import { stat } from "@plugins/packages/plugins/timed-fs/core";
import type { IsDir } from "./ref-files";

/** {@link IsDir} on the disk: absent (or under a file) is a real "no"; any other failure throws. */
export const isDirOnDisk: IsDir = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
};
