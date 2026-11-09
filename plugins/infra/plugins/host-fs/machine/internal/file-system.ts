import { serveValue } from "@plugins/network/plugins/live/machine";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import {
  FILE_BYTES_MAX,
  FILE_TEXT_MAX_BYTES,
  type FileStat,
  type FileText,
  archiveReasonMessage,
  computerFileBytes,
  computerFileRaw,
  computerFileStat,
  computerFileText,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { openHostFile } from "../../server/internal/open-file";
import { handleRaw as rawBytes } from "../../server/internal/raw";
import { statHostOrArchivePath } from "../../server/internal/stat";
import { readHostPathText } from "../../server/internal/text";
import { resolveOrRefuse, resolvedOrNull } from "./refuse";
import { watchHostPath } from "./version";

// The computer's disk as a file system (`{ fs: "computer" }`): file-systems'
// `computer` reads, answered by host-fs's own readers — a disk file or a
// member of an archive alike — and pushed while read from a watch of the
// path. The path spellings and refusals are host-fs's: absolute or `~`-rooted,
// `.`/`..` collapsed; an unreadable archive member is `unsupported`.

/** Watch one host path while a tuple of it is read — its entry, or its archive's. */
async function watchPath(
  path: string,
  notify: () => void,
): Promise<() => void> {
  const abs = resolvedOrNull(path);
  // The loader refuses the spelling; there is nothing to watch.
  if (abs === null) return () => {};
  return watchHostPath(abs, notify);
}

export const computerFileStatServed = serveValue(computerFileStat, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<FileStat> => {
    const stat = await statHostOrArchivePath(
      resolveOrRefuse(computerFileStat.refuse, path),
    );
    switch (stat.kind) {
      case "ok":
        return {
          path: stat.path,
          parent: stat.parent,
          entry: stat.entry,
          ...(stat.within !== undefined ? { within: stat.within } : {}),
          ...(stat.read !== undefined ? { read: stat.read } : {}),
        };
      case "missing":
        throw computerFileStat.refuse(
          "missing",
          `No such file or folder: ${stat.path}`,
        );
      case "denied":
        throw computerFileStat.refuse(
          "denied",
          `Permission denied: ${stat.path}`,
        );
      case "unreadable-archive":
        throw computerFileStat.refuse(
          "unsupported",
          `${archiveReasonMessage(stat.reason)}: ${stat.archive}`,
        );
    }
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

export const computerFileTextServed = serveValue(computerFileText, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<FileText> => {
    const text = await readHostPathText(
      resolveOrRefuse(computerFileText.refuse, path),
    );
    switch (text.kind) {
      case "ok":
        return { content: text.content, size: text.size };
      case "too-large":
        throw computerFileText.refuse(
          "too-large",
          `${text.path} is ${text.size} bytes, over the ${FILE_TEXT_MAX_BYTES}-byte text limit`,
        );
      case "binary":
        throw computerFileText.refuse(
          "binary",
          `${text.path} is a binary file`,
        );
      case "missing":
        throw computerFileText.refuse("missing", `No such file: ${text.path}`);
      case "denied":
        throw computerFileText.refuse(
          "denied",
          `Permission denied: ${text.path}`,
        );
      case "not-a-file":
        throw computerFileText.refuse("not-a-file", `Not a file: ${text.path}`);
      case "unreadable-archive":
        throw computerFileText.refuse(
          "unsupported",
          `${archiveReasonMessage(text.reason)}: ${text.archive}`,
        );
    }
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

/** The bytes in an `ArrayBuffer` of their own (a read may hand back a pooled view). */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const own = new Uint8Array(bytes.byteLength);
  own.set(bytes);
  return own.buffer;
}

export const computerFileBytesServed = serveValue(computerFileBytes, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<ArrayBuffer> => {
    const file = await openHostFile(
      resolveOrRefuse(computerFileBytes.refuse, path),
    );
    switch (file.kind) {
      case "ok":
        // Gated before the read: a huge file is never pulled into memory.
        if (file.size > FILE_BYTES_MAX) {
          throw computerFileBytes.refuse(
            "too-large",
            `${file.path} is ${file.size} bytes, over the ${FILE_BYTES_MAX}-byte limit`,
          );
        }
        return ownBuffer(await file.read());
      case "missing":
        throw computerFileBytes.refuse("missing", `No such file: ${file.path}`);
      case "denied":
        throw computerFileBytes.refuse(
          "denied",
          `Permission denied: ${file.path}`,
        );
      case "not-a-file":
        throw computerFileBytes.refuse(
          "not-a-file",
          `Not a file: ${file.path}`,
        );
      case "unreadable-archive":
        throw computerFileBytes.refuse(
          "unsupported",
          `${file.path} cannot be read from its archive (${file.reason}): ${file.archive}`,
        );
    }
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

/** `GET /api/files/computer/raw?path=` — host-fs's one byte server (inert headers, `Range`). */
export const handleComputerFileRaw = machineHandler(computerFileRaw, rawBytes);
