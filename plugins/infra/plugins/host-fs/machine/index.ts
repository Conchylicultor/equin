import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostFsDirPeekServed, hostFsListingServed } from "./internal/listing";
import {
  hostFsFileTextServed,
  hostFsPathStatServed,
  hostFsVolumeInfoServed,
} from "./internal/reads";
import { hostFsVersionServed } from "./internal/version";
import {
  hostFsComplete,
  hostFsExtract,
  hostFsMove,
  hostFsOpen,
  hostFsRaw,
  hostFsStat,
} from "../core";
import {
  handleComplete,
  handleExtract,
  handleMove,
  handleOpen,
  handleRaw,
  handleStat,
} from "./internal/routes";

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
    "host-fs's desktop half: the host filesystem as live values — host-fs.list (a folder's entries, key-range-paged by name, its path / parent / total / within as the meta sibling), host-fs.peek (a folder's child names, capped), host-fs.stat, host-fs.text (on demand), host-fs.volume (a snapshot) and host-fs.version (a host file's on-disk revision), each pushed from the shared dir hub while read and refusing missing / denied / … paths by code — plus hostPathVersion / watchHostPath / watchHostDir, which stamp and watch any absolute host path or folder (an archive member through its archive file). And the routes, each needsMachine: stat / complete / raw reads of any path the user account can read (filesystem permissions are the boundary; missing / denied / not-a-dir are typed results), POST open (Open with default app, Reveal in Finder), POST extract (an archive beside itself) and POST move (paths into a folder, a taken name answered `exists` until the caller resolves it) — the three POSTs refused unless the Origin is the app's own *.localhost.",
  httpRoutes: {
    [hostFsStat.route]: handleStat,
    [hostFsComplete.route]: handleComplete,
    [hostFsRaw.route]: handleRaw,
    [hostFsOpen.route]: handleOpen,
    [hostFsExtract.route]: handleExtract,
    [hostFsMove.route]: handleMove,
  },
  contributions: [
    ...hostFsVersionServed.declare,
    ...hostFsListingServed.declare,
    ...hostFsDirPeekServed.declare,
    ...hostFsPathStatServed.declare,
    ...hostFsFileTextServed.declare,
    ...hostFsVolumeInfoServed.declare,
  ],
} satisfies MachinePluginDefinition;
