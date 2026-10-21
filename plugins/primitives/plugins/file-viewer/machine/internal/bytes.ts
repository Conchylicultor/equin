import {
  hostPathVersion,
  resolveOrRefuse,
  resolvedOrNull,
  watchHostPath,
} from "@plugins/infra/plugins/host-fs/machine";
import { openHostFile } from "@plugins/infra/plugins/host-fs/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  readWorkspaceBytes,
  watchWorkspaceFile,
  workspaceFileSignature,
  workspaceRootReads,
  type WorkspaceFile,
} from "@plugins/code-explorer/machine";
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

/** A workspace file's bytes (code-explorer's read), or the refusal saying why there are none. */
async function workspaceBytes(file: WorkspaceFile): Promise<ArrayBuffer> {
  const where = `${file.workspace}:${file.path}${file.ref === undefined ? "" : ` at ${file.ref}`}`;
  const read = await readWorkspaceBytes(file, FILE_BYTES_MAX);
  switch (read.kind) {
    case "ok":
      return ownBuffer(read.bytes);
    case "too-large":
      throw fileBytes.refuse(
        "too-large",
        `${where} is ${read.size} bytes, over the ${FILE_BYTES_MAX}-byte limit`,
      );
    case "missing":
      throw fileBytes.refuse("missing", `No such file: ${where}`);
    case "no-workspace":
      throw fileBytes.refuse("missing", `No workspace ${file.workspace}`);
    case "denied":
      throw fileBytes.refuse("denied", `Permission denied: ${where}`);
    case "not-a-file":
      throw fileBytes.refuse("unsupported", `Not a file: ${where}`);
    case "not-a-checkout":
      throw fileBytes.refuse(
        "unsupported",
        `${file.workspace} is not a git checkout, so it has no revision to read ${file.path} at`,
      );
    case "unreadable-archive":
      throw fileBytes.refuse(
        "unsupported",
        `${where} cannot be read from its archive (${read.reason})`,
      );
    case "invalid-path":
      throw fileBytes.refuse(
        "invalid-path",
        `${JSON.stringify(file.path)} is not a path inside ${file.workspace}`,
      );
    case "invalid-ref":
      throw fileBytes.refuse(
        "invalid-path",
        `${JSON.stringify(file.ref)} is not a ref of ${file.workspace}`,
      );
  }
}

/**
 * A file's bytes, on demand. A host file is read through host-fs (a disk
 * file or an archive member alike) and invalidated from a watch of its folder
 * while read. A workspace file is read through code-explorer (on disk, or as
 * of a ref from the checkout's blob) and invalidated from its watch — the
 * file's entry, or the checkout's refs for a named ref; a sha never moves.
 * The ETag is the file's revision, probed before the read: an invalidation
 * that moved nothing — a write to the attempts table, which every tuple
 * declares — costs a 304, never a re-read of up to FILE_BYTES_MAX.
 */
export const fileBytesServed = serveValue(fileBytes, {
  source: "external",
  changes: "notified",
  // A workspace FileRef's attempt id resolves through its attempt row.
  reads: workspaceRootReads,
  revalidate: async (file) => {
    switch (file.source) {
      case "host": {
        const abs = resolvedOrNull(file.path);
        if (abs === null) return "invalid-path";
        return `host:${abs}:${(await hostPathVersion(abs)).stamp ?? "none"}`;
      }
      case "workspace":
        return `workspace:${await workspaceFileSignature(file)}`;
    }
  },
  loader: async (file) => {
    switch (file.source) {
      case "host":
        return hostBytes(file.path);
      case "workspace":
        return workspaceBytes(file);
    }
  },
  whileSubscribed: async (file, notify) => {
    switch (file.source) {
      case "host": {
        const abs = resolvedOrNull(file.path);
        // The loader refuses the spelling; there is nothing to watch.
        if (abs === null) return () => {};
        return watchHostPath(abs, () => notify());
      }
      case "workspace":
        return watchWorkspaceFile(file, () => notify());
    }
  },
});
