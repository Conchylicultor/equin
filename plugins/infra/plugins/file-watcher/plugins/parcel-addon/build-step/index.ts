// The patched @parcel/watcher addon (kqueue closes a deleted or renamed file's
// descriptor), linked into the `node_modules` the build just made current: the
// backend the build restarts loads it. Every install links it too (this
// plugin's provision); the build refreshes a stale identity. Cached per
// machine; a cold build compiles it once.
import { defineBuildStep } from "@plugins/framework/plugins/cli/plugins/build/plugins/build-steps/cli";
import { linkParcelWatcherAddon } from "../cli";

export default [
  defineBuildStep({
    id: "parcelWatcherAddon",
    owner: "infra/file-watcher/parcel-addon",
    label: "parcel-watcher addon",
    phase: "dependencies",
    run: ({ root, log }) => linkParcelWatcherAddon({ root, log }),
  }),
];
