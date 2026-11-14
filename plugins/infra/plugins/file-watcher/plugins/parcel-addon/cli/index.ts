// The step that puts the patched @parcel/watcher addon in place: every
// install runs it (this plugin's provision, through `scripts/link-addon.ts`),
// and `./equin build` again (this plugin's `build-step/`) to refresh a stale
// identity. No default export:
// shared CLI machinery, not a command declaration.
export { linkParcelWatcherAddon } from "./internal/link-parcel-addon";
