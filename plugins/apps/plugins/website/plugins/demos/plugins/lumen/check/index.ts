import { join } from "node:path";
import { prototypeFixtureThumbnailsCheck } from "@plugins/apps/plugins/prototypes/plugins/fixtures/machine";

// The demo's browser host renders no thumbnail: every prototype version it
// seeds shows the PNG committed in `data/thumbnails/`, so a version without one
// (or a PNG no version names) fails the build, with the render command.
export default [
  prototypeFixtureThumbnailsCheck({
    id: "demo:prototype-thumbnails-in-sync",
    dir: join(import.meta.dir, "..", "data"),
  }),
];
