import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { writeSongFixtures } from "./internal/write-songs";

export default {
  description:
    "Sonata fixtures, server half: writeSongFixtures writes SongFixtures through each source's real write path (a chord grid through the chord-grid source's create write), measuring a grid as the editor does. Derives nothing else.",
} satisfies ServerPluginDefinition;
