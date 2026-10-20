import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  hostFsComplete,
  hostFsExtract,
  hostFsMove,
  hostFsOpen,
  hostFsRaw,
  hostFsStat,
} from "../core";
import { handleComplete } from "./internal/complete";
import { handleExtract } from "./internal/extract";
import { handleMove } from "./internal/move";
import { handleOpen } from "./internal/open";
import { handleRaw } from "./internal/raw";
import { handleStat } from "./internal/stat";

export { inertHeaders, serveHostPath } from "./internal/raw";
export { readHostPathText } from "./internal/text";
export { resolveHostPath } from "./internal/path";
export { openHostFile, type HostFileOpen } from "./internal/open-file";
export { decodeTextBytes, type TextBytesResult } from "./internal/decode";
export {
  defineArchiveFormat,
  type ArchiveFormat,
  type ArchiveIndexResult,
  type ArchiveMember,
  type MemberBytes,
} from "./internal/archive/registry";

export default {
  description:
    "The one host-filesystem API: stat / complete / raw reads of any path the user account can read (filesystem permissions are the boundary; missing / denied / not-a-dir are typed results), POST open (Open with default app, Reveal in Finder) and POST extract (an archive beside itself, its single top-level entry as itself or several in a new folder) and POST move (paths into a folder, a taken name answered `exists` until the caller resolves it: replace / keep-both / skip), all three refused unless the Origin is the app's own *.localhost.",
  httpRoutes: {
    [hostFsStat.route]: handleStat,
    [hostFsComplete.route]: handleComplete,
    [hostFsRaw.route]: handleRaw,
    [hostFsOpen.route]: handleOpen,
    [hostFsExtract.route]: handleExtract,
    [hostFsMove.route]: handleMove,
  },
} satisfies ServerPluginDefinition;
