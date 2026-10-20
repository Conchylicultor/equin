import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostFsDirPeekServed, hostFsListingServed } from "./internal/listing";
import {
  hostFsFileTextServed,
  hostFsPathStatServed,
  hostFsVolumeInfoServed,
} from "./internal/reads";
import { hostFsVersionServed } from "./internal/version";

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
    "host-fs's desktop half: the host filesystem as live values — host-fs.list (a folder's entries, key-range-paged by name, its path / parent / total / within as the meta sibling), host-fs.peek (a folder's child names, capped), host-fs.stat, host-fs.text (on demand), host-fs.volume (a snapshot) and host-fs.version (a host file's on-disk revision), each pushed from the shared dir hub while read and refusing missing / denied / … paths by code — plus hostPathVersion / watchHostPath / watchHostDir, which stamp and watch any absolute host path or folder (an archive member through its archive file).",
  contributions: [
    ...hostFsVersionServed.declare,
    ...hostFsListingServed.declare,
    ...hostFsDirPeekServed.declare,
    ...hostFsPathStatServed.declare,
    ...hostFsFileTextServed.declare,
    ...hostFsVolumeInfoServed.declare,
  ],
} satisfies MachinePluginDefinition;
