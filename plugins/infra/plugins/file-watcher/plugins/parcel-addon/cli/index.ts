// The step `./equin build` runs to put the patched @parcel/watcher addon in
// place. No default export: shared CLI machinery, not a command declaration.
export { linkParcelWatcherAddon } from "./internal/link-parcel-addon";
