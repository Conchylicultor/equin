// @parcel/watcher's native addon built from the patched source, collected into infra/deps' registry through the `default`
// array (Debug → Dependencies, `./equin deps install parcel-watcher-addon`).
// Every install links it into the checkout (this plugin's `provision/`), and
// `./equin build` refreshes it (`linkParcelWatcherAddon`, the `cli/` barrel).
import { parcelWatcherAddon } from "./internal/parcel-addon";

export {
  parcelWatcherAddon,
  parcelWatcherPackageDir,
} from "./internal/parcel-addon";

export default [parcelWatcherAddon];
