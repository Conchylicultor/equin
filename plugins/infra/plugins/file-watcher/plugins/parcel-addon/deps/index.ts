// @parcel/watcher's native addon built from the patched source, collected into infra/deps' registry through the `default`
// array (Debug → Dependencies, `./equin deps install parcel-watcher-addon`).
// `./equin build` ensures it and links it into the checkout
// (`linkParcelWatcherAddon`, this plugin's `cli/` barrel).
import { parcelWatcherAddon } from "./internal/parcel-addon";

export {
  parcelWatcherAddon,
  parcelWatcherPackageDir,
} from "./internal/parcel-addon";

export default [parcelWatcherAddon];
