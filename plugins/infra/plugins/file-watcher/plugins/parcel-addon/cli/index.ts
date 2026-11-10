// The steps that put the patched @parcel/watcher addon in place: `./equin
// build` links it every build; `./equin test` / `./equin run` link it when an
// install dropped it. No default export: shared CLI machinery, not a command
// declaration.
export {
  ensureParcelWatcherAddonLinked,
  linkParcelWatcherAddon,
} from "./internal/link-parcel-addon";
