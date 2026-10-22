import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

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
    "The host-filesystem readers other plugins build on: resolveHostPath, openHostFile (a disk file or an archive member), serveHostPath (the one byte server), readHostPathText / decodeTextBytes (the size + binary gate) and the archive-format registry (defineArchiveFormat). Its routes — stat / complete / raw reads of any path the user account can read, POST open / extract / move — are the machine half's, each needsMachine.",
} satisfies ServerPluginDefinition;
