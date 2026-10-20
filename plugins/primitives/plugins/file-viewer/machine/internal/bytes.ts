import {
  resolveOrRefuse,
  resolvedOrNull,
  watchHostPath,
} from "@plugins/infra/plugins/host-fs/machine";
import { openHostFile } from "@plugins/infra/plugins/host-fs/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { FILE_BYTES_MAX, fileBytes } from "../../core";

/**
 * The bytes in an `ArrayBuffer` of their own — what a bytes value answers (a
 * read may hand back a view into a larger, pooled buffer).
 */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const own = new Uint8Array(bytes.byteLength);
  own.set(bytes);
  return own.buffer;
}

/** A host file's bytes, or the refusal saying why there are none. */
async function hostBytes(path: string): Promise<ArrayBuffer> {
  const file = await openHostFile(resolveOrRefuse(fileBytes.refuse, path));
  switch (file.kind) {
    case "ok":
      // Gated before the read: a huge file is never pulled into memory.
      if (file.size > FILE_BYTES_MAX) {
        throw fileBytes.refuse(
          "too-large",
          `${file.path} is ${file.size} bytes, over the ${FILE_BYTES_MAX}-byte limit`,
        );
      }
      return ownBuffer(await file.read());
    case "missing":
      throw fileBytes.refuse("missing", `No such file: ${file.path}`);
    case "denied":
      throw fileBytes.refuse("denied", `Permission denied: ${file.path}`);
    case "not-a-file":
      throw fileBytes.refuse("unsupported", `Not a file: ${file.path}`);
    case "unreadable-archive":
      throw fileBytes.refuse(
        "unsupported",
        `${file.path} cannot be read from its archive (${file.reason}): ${file.archive}`,
      );
  }
}

/**
 * A file's bytes, on demand. A host file is read through host-fs (a disk
 * file or an archive member alike) and invalidated from a watch of its folder
 * while read. A workspace file is refused `unsupported`: its bytes are
 * code-api's to read (the image route serves image formats only), which has
 * no live form yet — see the plugin's CLAUDE.md.
 */
export const fileBytesServed = serveValue(fileBytes, {
  source: "external",
  changes: "notified",
  loader: async (file) => {
    switch (file.source) {
      case "host":
        return hostBytes(file.path);
      case "workspace":
        throw fileBytes.refuse(
          "unsupported",
          `A workspace file's bytes are not served as a live read: ${file.workspace}:${file.path}`,
        );
    }
  },
  whileSubscribed: async (file, notify) => {
    if (file.source !== "host") return () => {};
    const abs = resolvedOrNull(file.path);
    // The loader refuses the spelling; there is nothing to watch.
    if (abs === null) return () => {};
    return watchHostPath(abs, () => notify());
  },
});
