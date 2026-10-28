import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

// What a host process reads off disk: a fixture directory, and the check over
// its thumbnails a fixture's owner contributes from its `check/`.
export { readPrototypeFixtureDir } from "./internal/disk";
export { prototypeFixtureThumbnailsCheck } from "./internal/check";

export default {
  description:
    "Prototype fixtures, host half: reads a fixture directory (prototypes/ + thumbnails/) off disk, and the thumbnails-in-sync check a fixture's owner contributes from its check/. Contributes nothing to a running host.",
} satisfies MachinePluginDefinition;
