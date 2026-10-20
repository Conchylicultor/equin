import { readFile, stat } from "node:fs/promises";
import { HOST_FS_TEXT_MAX_BYTES, type HostFsTextResult } from "../../core";
import { locateHostPath } from "./archive/locate";
import { readArchiveText } from "./archive/read";
import { decodeTextBytes } from "./decode";
import { classifyFsError } from "./path";

/** Read the absolute host file `path` as text. The size gate runs before the read. */
export async function readHostText(path: string): Promise<HostFsTextResult> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return { kind: "not-a-file", path };
    if (st.size > HOST_FS_TEXT_MAX_BYTES)
      return { kind: "too-large", path, size: st.size };
    const bytes = await readFile(path);
    const decoded = decodeTextBytes(bytes);
    // The file may have grown between the stat and the read: the gate and the
    // reported size are both about the bytes actually read.
    return { ...decoded, path, size: bytes.length };
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
}

/** Read the absolute host path `path` as text — a file on disk or a member of an archive. */
export async function readHostPathText(
  path: string,
): Promise<HostFsTextResult> {
  const located = await locateHostPath(path);
  return located.kind === "archive"
    ? readArchiveText(path, located)
    : readHostText(path);
}
