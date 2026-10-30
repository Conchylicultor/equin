import { join } from "node:path";
import { prototypeFixtureThumbnailsCheck } from "@plugins/apps/plugins/prototypes/plugins/fixtures/machine";

// The film's prototype fixture carries a gallery PNG per version, so the
// writer can lay it down on a host where it is absent; a version without one
// (or a PNG no version names) fails, with the render command.
export default [
  prototypeFixtureThumbnailsCheck({
    id: "promo-film:prototype-thumbnails-in-sync",
    dir: join(import.meta.dir, "..", "data"),
  }),
];
