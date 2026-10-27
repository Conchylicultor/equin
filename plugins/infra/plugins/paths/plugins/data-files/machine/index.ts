import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/server";
import { diskDataFiles, fileRootBindings } from "./internal/bindings";

export { FileRootLocation, diskDirMount, diskMount } from "./internal/bindings";

export default {
  description:
    "Data files, desktop half: provides the DataFiles host service over this computer's disk — each declared root bound by its owner's FileRootLocation(root, dataDir) (boot fails on a root unbound, bound twice or bound to another dir), atomic temp-then-rename writes, reads off one open descriptor (stat and bytes together, so a racing remove is a typed miss), flock-based withLock on the same <key>.lock files the CLI takes, one declared file watcher per watching root (a dropped-events report, onLost, a rescan) and one agent-write ledger per ledgered root. diskMount(dataDir) is the same operations for a CLI process.",
  contributions: [DataFiles.provide(diskDataFiles)],
  register: [fileRootBindings],
} satisfies MachinePluginDefinition;
