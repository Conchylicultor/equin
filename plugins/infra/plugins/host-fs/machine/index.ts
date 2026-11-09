import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  computerDirPeekServed,
  computerFileListingServed,
} from "./internal/listing";
import { computerVolumeServed } from "./internal/reads";
import {
  computerFileBytesServed,
  computerFileStatServed,
  computerFileTextServed,
  handleComputerFileRaw,
} from "./internal/file-system";
import {
  computerFileExtract,
  computerFileMove,
  computerFileOpen,
  computerFileRaw,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { FileSystemProvided } from "@plugins/infra/plugins/paths/plugins/file-systems/server";
import { computerFileCompletionsServed } from "./internal/complete";
import { handleExtract, handleMove, handleOpen } from "./internal/routes";

export { hostPathVersion, watchHostPath } from "./internal/version";
export { watchHostDir } from "./internal/watch-dir";
export { listHostPath } from "../server/internal/list";
export {
  refusalFor,
  resolveOrRefuse,
  resolvedOrNull,
  type HostFsFailure,
} from "./internal/refuse";

export default {
  description:
    "host-fs's desktop half: the computer's disk as a file system — file-systems' `computer` declarations, provided as FileSystemProvided(\"computer\"), each pushed from the shared dir hub while read and refusing missing / denied / … paths by code: files.computer.list (a folder's entries, key-range-paged by name, cut from one held listing per folder; its path / parent / total / within as the meta sibling) / .peek (a folder's child names, capped) / .stat / .text / .bytes / .complete (a typed path's folder completions, capped) / .volume (a snapshot) and GET /api/files/computer/raw — plus hostPathVersion / watchHostPath / watchHostDir, which stamp and watch any absolute host path or folder (an archive member through its archive file). And the routes, each needsMachine: GET /api/files/computer/raw (the bytes of any path the user account can read — filesystem permissions are the boundary) and file-systems' computer writes: POST open (Open with default app, Reveal in Finder), POST extract (an archive beside itself) and POST move (paths into a folder, a taken name answered `exists` until the caller resolves it) — the three POSTs refused unless the Origin is the app's own *.localhost.",
  httpRoutes: {
    [computerFileOpen.route]: handleOpen,
    [computerFileExtract.route]: handleExtract,
    [computerFileMove.route]: handleMove,
    [computerFileRaw.route]: handleComputerFileRaw,
  },
  contributions: [
    ...computerFileListingServed.declare,
    ...computerDirPeekServed.declare,
    ...computerFileCompletionsServed.declare,
    ...computerFileStatServed.declare,
    ...computerFileTextServed.declare,
    ...computerFileBytesServed.declare,
    ...computerVolumeServed.declare,
    FileSystemProvided("computer"),
  ],
} satisfies MachinePluginDefinition;
