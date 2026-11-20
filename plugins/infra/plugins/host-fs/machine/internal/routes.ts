import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  computerFileCompress,
  computerFileCopy,
  computerFileCreate,
  computerFileDelete,
  computerFileExtract,
  computerFileMove,
  computerFileOpen,
  computerFileRename,
  computerFileTrash,
  computerFileWrite,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import {
  createHostEntry,
  deleteHostPaths,
  renameHostEntry,
  trashHostPaths,
  writeHostText,
} from "./edit";
import { compressHostPaths, copyHostPaths } from "./transfer";
import { extractHostArchive } from "../../server/internal/extract";
import { moveHostPaths } from "../../server/internal/move";
import { openHostPath } from "../../server/internal/open";
import { resolveHostPath } from "../../server/internal/path";

// host-fs's routes: every one reads or changes the host filesystem, so each
// endpoint is declared `needsMachine` and served here — a host without the
// computer (the in-browser demo) answers it unavailable without a request.
// The writes (open, extract, move, copy, compress, and the edits: create, rename, delete,
// trash, write) are file-systems' `computer` endpoints; the
// reads a surface makes (stat, complete, …) are live values (`./reads.ts`,
// `./complete.ts`); `raw` (file-systems' `computerFileRaw`, `./file-system.ts`) stays a route because a byte URL is an asset.
// Who may call them is the socket host's principal gate, not a per-route
// Origin check: every route here is owner-only (no `access: { public }`), so a
// foreign site is refused before a handler runs (`framework/principal`).

export const handleOpen = implementMachine(computerFileOpen, ({ body }) => {
  if (process.platform !== "darwin") {
    throw new HttpError(
      501,
      `Open with default app is macOS-only (this host is ${process.platform})`,
    );
  }
  return openHostPath(resolveHostPath(body.path), body.reveal ?? false);
});

export const handleExtract = implementMachine(computerFileExtract, ({ body }) =>
  extractHostArchive(resolveHostPath(body.path)),
);

export const handleMove = implementMachine(computerFileMove, ({ body }) => {
  const resolutions = new Map(
    Object.entries(body.resolutions ?? {}).map(
      ([source, resolution]) => [resolveHostPath(source), resolution] as const,
    ),
  );
  return moveHostPaths(
    body.sources.map((source) => resolveHostPath(source)),
    resolveHostPath(body.destDir),
    resolutions,
  );
});

export const handleCopy = implementMachine(computerFileCopy, ({ body }) =>
  copyHostPaths(
    body.sources.map((source) => resolveHostPath(source)),
    resolveHostPath(body.destDir),
  ),
);

export const handleCompress = implementMachine(
  computerFileCompress,
  ({ body }) => compressHostPaths(body.paths.map((p) => resolveHostPath(p))),
);

export const handleCreate = implementMachine(computerFileCreate, ({ body }) =>
  createHostEntry(resolveHostPath(body.dir), body.name, body.kind),
);

export const handleRename = implementMachine(computerFileRename, ({ body }) =>
  renameHostEntry(resolveHostPath(body.path), body.name),
);

export const handleDelete = implementMachine(computerFileDelete, ({ body }) =>
  deleteHostPaths(body.paths.map((p) => resolveHostPath(p))),
);

export const handleTrash = implementMachine(computerFileTrash, ({ body }) =>
  trashHostPaths(body.paths.map((p) => resolveHostPath(p))),
);

export const handleWrite = implementMachine(computerFileWrite, ({ body }) =>
  writeHostText(resolveHostPath(body.path), body.text, body.expected),
);
