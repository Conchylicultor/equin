import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// A demo's seed (or a test) writes its prototypes through this: the fixture's
// shapes and parser are the `core` barrel's.
export { writePrototypeFixture } from "./internal/write";

export default {
  description:
    "Writes a prototype fixture into a running host through the app's real write path: the thumbnail cache first, each folder's v0 renamed into the prototypesFiles root, the files watcher's own history adoption (settled and asserted), each step as a turn checkpoint, the _picks records, then the tag and state rows. Portable, and contributes nothing: a host boots it for the seed that imports it.",
  portable: true,
} satisfies ServerPluginDefinition;
