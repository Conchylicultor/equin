import {
  getBootMode,
  type ServerPluginDefinition,
} from "@plugins/framework/plugins/server-core/core";
import { prewarmSourceDigests } from "../shared/digest";

export {
  closureChangedSince,
  computedLoads,
  sourceDigest,
} from "../shared/digest";
export type { ComputedLoads } from "../shared/digest";

export default {
  description:
    "Digest of the code a source set loads: sourceDigest(sets) — sha256 over the static runtime import closure of the modules each set includes (repo files by relative path and bytes, packages by name@version, builtins by name; type-only imports erased), computed once per process, every defined set started at a serving backend's boot. What persisted or inherited state stamps itself with, so a cache built by other code is refused without a version anyone bumps.",
  onReadyBlocking() {
    // Not awaited: started first thing so each digest reads the files as
    // close as possible to when their modules were imported; whoever needs
    // one awaits it then. A serving backend only: an `exec` child (a job's
    // body) hands nothing to a successor, and a digest it does need is
    // computed when asked.
    if (getBootMode() === "serve") prewarmSourceDigests();
  },
} satisfies ServerPluginDefinition;
