import {
  hostPathVersion,
  resolveOrRefuse,
  resolvedOrNull,
  watchHostPath,
} from "@plugins/infra/plugins/host-fs/machine";
import { openHostFile } from "@plugins/infra/plugins/host-fs/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { attemptWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import {
  readWorkspaceBytes,
  watchWorkspaceFile,
  workspaceAttemptIds,
  workspaceFileSignature,
  workspaceRootFrom,
  type WorkspaceFile,
  type WorkspaceRoot,
} from "@plugins/code-explorer/machine";
import {
  browsableFileRevision,
  readBrowsableFile,
  watchBrowsableFile,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
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

/** A workspace file's bytes under its `root` (code-explorer's read), or the refusal saying why there are none. */
async function workspaceBytes(
  file: WorkspaceFile,
  root: WorkspaceRoot | null,
): Promise<ArrayBuffer> {
  const where = `${file.workspace}:${file.path}${file.ref === undefined ? "" : ` at ${file.ref}`}`;
  const read = await readWorkspaceBytes(file, root, FILE_BYTES_MAX);
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

/** A browsable data root's file's bytes (data-files), or the refusal saying why there are none. */
async function dataBytes(root: string, path: string): Promise<ArrayBuffer> {
  const where = `${root}:${path}`;
  const read = await readBrowsableFile(root, path, FILE_BYTES_MAX);
  switch (read.kind) {
    case "file":
      return read.bytes;
    case "too-large":
      throw fileBytes.refuse(
        "too-large",
        `${where} is ${read.size} bytes, over the ${FILE_BYTES_MAX}-byte limit`,
      );
    case "missing":
      throw fileBytes.refuse("missing", `No such file: ${where}`);
    case "unknown-root":
      throw fileBytes.refuse("missing", `No browsable file root ${root}`);
    case "not-a-file":
      throw fileBytes.refuse("unsupported", `Not a file: ${where}`);
    case "invalid-path":
      throw fileBytes.refuse("invalid-path", read.message);
  }
}

/**
 * A file's bytes, on demand. A host file is read through host-fs (a disk
 * file or an archive member alike) and invalidated from a watch of its folder
 * while read. A workspace file is read through code-explorer (on disk, or as
 * of a ref from the checkout's blob) and invalidated from its watch — the
 * file's entry, or the checkout's refs for a named ref; a sha never moves.
 * A data file is read through its browsable file root (data-files) and
 * invalidated from the root's watch.
 * A workspace file's root is its attempt row, FOLLOWED (tasks-core's
 * `attemptWorkspaces` by the workspace's attempt; a host or data file, a
 * sentinel or a path workspace follows none): only a write to that
 * attempt's workspace reaches the tuple, and re-points its watch.
 * The ETag is the file's revision, probed before the read: an invalidation
 * that moved nothing costs a 304, never a re-read of up to FILE_BYTES_MAX.
 */
export const fileBytesServed = serveValue(fileBytes, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, (file) => ({
      ids:
        file.source === "workspace" ? workspaceAttemptIds(file.workspace) : [],
    })),
  }),
  loader: async (file, { followed }) => {
    switch (file.source) {
      case "host":
        return hostBytes(file.path);
      case "workspace":
        return workspaceBytes(
          file,
          await workspaceRootFrom(file.workspace, followed.ws),
        );
      case "data":
        return dataBytes(file.root, file.path);
    }
  },
  revalidate: async (file, { followed }) => {
    switch (file.source) {
      case "host": {
        const abs = resolvedOrNull(file.path);
        if (abs === null) return "invalid-path";
        return `host:${abs}:${(await hostPathVersion(abs)).stamp ?? "none"}`;
      }
      case "workspace":
        return `workspace:${await workspaceFileSignature(
          file,
          await workspaceRootFrom(file.workspace, followed.ws),
        )}`;
      case "data":
        return `data:${await browsableFileRevision(file.root, file.path)}`;
    }
  },
  whileFollowing: {
    over: (followed) => followed.ws,
    start: async (file, { over: ws, notify }) => {
      switch (file.source) {
        case "host": {
          const abs = resolvedOrNull(file.path);
          // The loader refuses the spelling; there is nothing to watch.
          if (abs === null) return () => {};
          return watchHostPath(abs, () => notify());
        }
        case "workspace":
          return watchWorkspaceFile(
            file,
            await workspaceRootFrom(file.workspace, ws),
            () => notify(),
          );
        case "data":
          return watchBrowsableFile(file.root, file.path, () => notify());
      }
    },
  },
});
