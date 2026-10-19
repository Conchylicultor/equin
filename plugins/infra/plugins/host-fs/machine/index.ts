import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hostFsVersionServed } from "./internal/version";

export {
  hostPathVersion,
  watchHostPath,
  type HostPathWatch,
} from "./internal/version";

export default {
  description:
    "host-fs's desktop half: the host-fs.version live value (a host file's on-disk revision, pushed from a watch of its folder) and hostPathVersion / watchHostPath, which stamp and watch any absolute host path (an archive member through its archive file).",
  contributions: [...hostFsVersionServed.declare],
} satisfies MachinePluginDefinition;
